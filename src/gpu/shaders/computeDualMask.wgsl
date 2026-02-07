// ============================================================================
// Compute Dual Mask Shader - Secondary Brush Mask Accumulation (Parametric)
// ============================================================================
//
// Outputs a single-channel mask (stored in .r) using Alpha Darken accumulation.
// Matches CPU StrokeAccumulator.stampSecondaryDab() + MaskCache logic.
// ============================================================================

struct DabData {
  center_x: f32,
  center_y: f32,
  radius: f32,
  hardness: f32,
  color_r: f32,
  color_g: f32,
  color_b: f32,
  dab_opacity: f32,
  flow: f32,
  roundness: f32,
  angle_cos: f32,
  angle_sin: f32,
};

struct Uniforms {
  bbox_offset: vec2<u32>,
  bbox_size: vec2<u32>,
  canvas_size: vec2<u32>,
  dab_count: u32,
  padding: u32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dabs: array<DabData>;
@group(0) @binding(2) var input_tex: texture_2d<f32>;
@group(0) @binding(3) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<storage, read> gaussian_table: array<f32>;

const MAX_SHARED_DABS: u32 = 128u;
var<workgroup> shared_dabs: array<DabData, MAX_SHARED_DABS>;
var<workgroup> shared_dab_count: u32;

fn erf_approx(x: f32) -> f32 {
  let sign_x = sign(x);
  let ax = abs(x);

  let MAX_VAL = 4.0;
  let LUT_SIZE = 1024.0;
  let SCALE = 256.0;

  if (ax >= MAX_VAL) {
    return sign_x;
  }

  let idx = ax * SCALE;
  let i = u32(idx);
  let frac = fract(idx);

  let y0 = gaussian_table[i];
  let y1 = gaussian_table[i + 1u];
  let y = mix(y0, y1, frac);

  return sign_x * y;
}

fn calculate_effective_radius(radius: f32, hardness: f32) -> f32 {
  if (radius < 2.0) {
    return max(1.5, radius + 1.0);
  }
  if (hardness >= 0.99) {
    return radius * 1.1;
  }
  let geometric_fade = (1.0 - hardness) * 2.5;
  return radius * max(1.1, 1.0 + geometric_fade);
}

fn compute_ellipse_distance(pixel: vec2<f32>, dab: DabData) -> f32 {
  let offset = pixel - vec2<f32>(dab.center_x, dab.center_y);

  let rotated = vec2<f32>(
    offset.x * dab.angle_cos - offset.y * dab.angle_sin,
    offset.x * dab.angle_sin + offset.y * dab.angle_cos
  );

  let r = dab.radius;
  let roundness = max(0.01, dab.roundness);
  let scaled = vec2<f32>(rotated.x, rotated.y / roundness);
  return length(scaled);
}

fn compute_mask(dist: f32, radius: f32, hardness: f32) -> f32 {
  if (radius < 1.5) {
    let sigma = max(0.5, radius * 0.75);
    return exp(-(dist * dist) / (2.0 * sigma * sigma));
  }

  if (hardness >= 0.99 && radius >= 1.5) {
    let edge_dist = radius;
    let sharp_alpha = 1.0 - smoothstep(edge_dist - 0.5, edge_dist + 0.5, dist);
    if (hardness >= 0.999) {
      return sharp_alpha;
    }
    let base_sigma = max(0.5, radius * 0.75);
    let softness_factor = max(0.1, 1.0 - hardness);
    let sigma = base_sigma * softness_factor;
    let soft_alpha = exp(-(dist * dist) / (2.0 * sigma * sigma));
    let blend = (radius - 1.5) / 1.5;
    return mix(soft_alpha, sharp_alpha, blend * hardness);
  }

  let safe_fade = max(1e-6, min(2.0, (1.0 - hardness) * 2.0));
  let SQRT_2 = 1.41421356;
  let center = (2.5 * (6761.0 * safe_fade - 10000.0)) / (SQRT_2 * 6761.0 * safe_fade);
  let alphafactor = 1.0 / (2.0 * erf_approx(center));
  let distfactor = (SQRT_2 * 12500.0) / (6761.0 * safe_fade * radius);
  let scaled_dist = dist * distfactor;
  let val = alphafactor * (erf_approx(scaled_dist + center) - erf_approx(scaled_dist - center));
  return saturate(val);
}

fn alpha_darken_mask(dst: f32, src: f32) -> f32 {
  if (src <= 0.001) {
    return dst;
  }
  if (dst >= 0.999) {
    return dst;
  }
  return dst + (1.0 - dst) * src;
}

@compute @workgroup_size(8, 8)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_index) local_idx: u32
) {
  let dabs_to_load = min(uniforms.dab_count, MAX_SHARED_DABS);
  if (local_idx == 0u) {
    shared_dab_count = dabs_to_load;
  }
  workgroupBarrier();

  let threads_per_workgroup = 64u;
  var load_idx = local_idx;
  while (load_idx < dabs_to_load) {
    shared_dabs[load_idx] = dabs[load_idx];
    load_idx += threads_per_workgroup;
  }
  workgroupBarrier();

  let local_x = gid.x;
  let local_y = gid.y;

  if (local_x >= uniforms.bbox_size.x || local_y >= uniforms.bbox_size.y) {
    return;
  }

  let pixel_x = uniforms.bbox_offset.x + local_x;
  let pixel_y = uniforms.bbox_offset.y + local_y;

  if (pixel_x >= uniforms.canvas_size.x || pixel_y >= uniforms.canvas_size.y) {
    return;
  }

  let pixel = vec2<f32>(f32(pixel_x) + 0.5, f32(pixel_y) + 0.5);

  var mask_value = textureLoad(input_tex, vec2<i32>(i32(pixel_x), i32(pixel_y)), 0).r;

  for (var i = 0u; i < shared_dab_count; i++) {
    let dab = shared_dabs[i];
    let dab_center = vec2<f32>(dab.center_x, dab.center_y);

    let effective_radius = calculate_effective_radius(dab.radius, dab.hardness);
    let quick_dist = distance(pixel, dab_center);
    if (quick_dist > effective_radius) {
      continue;
    }

    let dist = compute_ellipse_distance(pixel, dab);
    let mask = compute_mask(dist, dab.radius, dab.hardness);
    if (mask < 0.001) {
      continue;
    }

    mask_value = alpha_darken_mask(mask_value, mask);
    if (mask_value >= 0.999) {
      break;
    }
  }

  textureStore(output_tex, vec2<i32>(i32(pixel_x), i32(pixel_y)), vec4<f32>(mask_value, 0.0, 0.0, 0.0));
}

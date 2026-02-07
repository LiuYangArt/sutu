// ============================================================================
// Compute Dual Texture Mask Shader - Secondary Brush Mask Accumulation (Texture)
// ============================================================================
//
// Outputs a single-channel mask (stored in .r) using Alpha Darken accumulation.
// Matches CPU TextureMaskCache + StrokeAccumulator.stampSecondaryDab().
// ============================================================================

struct TextureDabData {
  center_x: f32,
  center_y: f32,
  size: f32,
  roundness: f32,
  angle: f32,
  color_r: f32,
  color_g: f32,
  color_b: f32,
  dab_opacity: f32,
  flow: f32,
  tex_width: f32,
  tex_height: f32,
};

struct Uniforms {
  bbox_offset: vec2<u32>,
  bbox_size: vec2<u32>,
  canvas_size: vec2<u32>,
  dab_count: u32,
  padding: u32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dabs: array<TextureDabData>;
@group(0) @binding(2) var input_tex: texture_2d<f32>;
@group(0) @binding(3) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var brush_texture: texture_2d<f32>;

const MAX_SHARED_DABS: u32 = 128u;
var<workgroup> shared_dabs: array<TextureDabData, MAX_SHARED_DABS>;
var<workgroup> shared_dab_count: u32;

fn sample_texture_bilinear(tex: texture_2d<f32>, uv: vec2<f32>) -> f32 {
  let tex_dims = vec2<f32>(textureDimensions(tex));

  let texel_coord = uv * tex_dims - 0.5;
  let texel_floor = floor(texel_coord);
  let frac = texel_coord - texel_floor;

  let x0 = i32(clamp(texel_floor.x, 0.0, tex_dims.x - 1.0));
  let y0 = i32(clamp(texel_floor.y, 0.0, tex_dims.y - 1.0));
  let x1 = i32(clamp(texel_floor.x + 1.0, 0.0, tex_dims.x - 1.0));
  let y1 = i32(clamp(texel_floor.y + 1.0, 0.0, tex_dims.y - 1.0));

  let s00 = textureLoad(tex, vec2<i32>(x0, y0), 0).r;
  let s10 = textureLoad(tex, vec2<i32>(x1, y0), 0).r;
  let s01 = textureLoad(tex, vec2<i32>(x0, y1), 0).r;
  let s11 = textureLoad(tex, vec2<i32>(x1, y1), 0).r;

  let top = mix(s00, s10, frac.x);
  let bottom = mix(s01, s11, frac.x);
  return mix(top, bottom, frac.y);
}

fn calculate_half_dimensions(dab: TextureDabData) -> vec2<f32> {
  let tex_aspect = dab.tex_width / dab.tex_height;
  let diameter = max(1.0, dab.size);

  var half_width = diameter * 0.5;
  var half_height = diameter * 0.5;

  if (tex_aspect > 1.0) {
    half_height = half_width / tex_aspect;
  } else {
    half_width = half_height * tex_aspect;
  }

  return vec2<f32>(half_width, half_height * dab.roundness);
}

fn compute_texture_mask(pixel: vec2<f32>, dab: TextureDabData) -> f32 {
  let offset = pixel - vec2<f32>(dab.center_x, dab.center_y);

  let cos_a = cos(-dab.angle);
  let sin_a = sin(-dab.angle);
  let rotated = vec2<f32>(
    offset.x * cos_a - offset.y * sin_a,
    offset.x * sin_a + offset.y * cos_a
  );

  let half_dims = calculate_half_dimensions(dab);
  let radius = dab.size / 2.0;
  let SMALL_BRUSH_THRESHOLD = 3.0;

  if (radius < SMALL_BRUSH_THRESHOLD) {
    let scaled_offset = vec2<f32>(rotated.x, rotated.y / max(dab.roundness, 0.01));
    let dist = length(scaled_offset);

    let min_half_dim = min(half_dims.x, half_dims.y);
    let base_sigma = max(min_half_dim, 0.5);
    let sigma = base_sigma * 1.2;

    var alpha = exp(-(dist * dist) / (2.0 * sigma * sigma));

    if (radius >= 1.5) {
      let normalized = rotated / half_dims;
      let uv = (normalized + 1.0) / 2.0;

      if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
        let tex_mask = sample_texture_bilinear(brush_texture, uv);
        let blend = (radius - 1.5) / 1.5;
        alpha = mix(alpha, tex_mask, blend);
      }
    }

    return min(1.0, alpha);
  }

  let normalized = rotated / half_dims;
  let uv = (normalized + 1.0) / 2.0;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 0.0;
  }

  return sample_texture_bilinear(brush_texture, uv);
}

fn calculate_effective_radius(dab: TextureDabData) -> f32 {
  let half_dims = calculate_half_dimensions(dab);
  return length(half_dims);
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
    let effective_radius = calculate_effective_radius(dab);
    let dist = distance(pixel, dab_center);
    if (dist > effective_radius + 1.0) {
      continue;
    }

    let mask = compute_texture_mask(pixel, dab);
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

// ============================================================================
// Compute Brush Shader - Batch Rendering with Compute Shader
// ============================================================================
//
// This shader implements batched dab rendering using Compute Shader:
// - Single dispatch for all dabs in a batch (vs per-dab render passes)
// - Shared memory optimization for dab data
// - Only processes pixels within the bounding box
// - Alpha Darken blending (matches brush.wgsl exactly)
//
// Performance target: 64 dabs in ~8-12ms (vs ~68ms with per-dab render passes)
// ============================================================================

// ============================================================================
// Data Structures
// ============================================================================

// IMPORTANT: This struct must match the TypeScript packDabData() layout exactly!
// Using individual f32 fields instead of vec3 to avoid WGSL alignment issues.
// Total: 12 floats = 48 bytes per dab (no implicit padding)
struct DabData {
  center_x: f32,          // Dab center X (offset 0)
  center_y: f32,          // Dab center Y (offset 4)
  radius: f32,            // Dab radius (offset 8)
  hardness: f32,          // Hardness 0-1 (offset 12)
  color_r: f32,           // RGB color R (offset 16)
  color_g: f32,           // RGB color G (offset 20)
  color_b: f32,           // RGB color B (offset 24)
  dab_opacity: f32,       // Alpha Darken ceiling (offset 28)
  flow: f32,              // Flow multiplier (offset 32)
  _padding0: f32,         // Padding (offset 36)
  _padding1: f32,         // Padding (offset 40)
  _padding2: f32,         // Padding (offset 44)
};

struct Uniforms {
  bbox_offset: vec2<u32>, // Bounding box top-left offset
  bbox_size: vec2<u32>,   // Bounding box size
  canvas_size: vec2<u32>, // Canvas actual size (for bounds protection)
  dab_count: u32,
  color_blend_mode: u32,  // 0 = sRGB (8-bit quantize), 1 = linear
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dabs: array<DabData>;
@group(0) @binding(2) var input_tex: texture_2d<f32>;   // Read source (Ping)
@group(0) @binding(3) var output_tex: texture_storage_2d<rgba32float, write>; // Write target (Pong)
@group(0) @binding(4) var<storage, read> gaussian_table: array<f32>;  // Gaussian LUT

// ============================================================================
// Shared Memory Optimization: Cache Dab Data to Workgroup Shared Memory
// ============================================================================
const MAX_SHARED_DABS: u32 = 128u;
var<workgroup> shared_dabs: array<DabData, MAX_SHARED_DABS>;
var<workgroup> shared_dab_count: u32;

// ============================================================================
// Error Function Approximation (matches brush.wgsl exactly)
// ============================================================================
fn erf_approx(x: f32) -> f32 {
  let sign_x = sign(x);
  let ax = abs(x);

  let MAX_VAL = 4.0;
  let LUT_SIZE = 1024.0;
  let SCALE = 256.0; // LUT_SIZE / MAX_VAL

  if (ax >= MAX_VAL) {
    return sign_x;
  }

  let idx = ax * SCALE;
  let i = u32(idx);
  let frac = fract(idx);

  // Linear interpolation
  let y0 = gaussian_table[i];
  let y1 = gaussian_table[i + 1u];
  let y = mix(y0, y1, frac);

  return sign_x * y;
}

// ============================================================================
// Quantize to 8-bit (matches brush.wgsl)
// ============================================================================
fn quantize_to_8bit(val: f32) -> f32 {
  return floor(val * 255.0 + 0.5) / 255.0;
}

// ============================================================================
// Alpha Darken Blend (matches brush.wgsl exactly)
// ============================================================================
fn alpha_darken_blend(dst: vec4<f32>, src_color: vec3<f32>, src_alpha: f32, ceiling: f32) -> vec4<f32> {
  // Early stop: already at ceiling
  if (dst.a >= ceiling - 0.001) {
    return dst;
  }

  let new_alpha = dst.a + (ceiling - dst.a) * src_alpha;

  var new_rgb: vec3<f32>;
  if (dst.a > 0.001) {
    new_rgb = dst.rgb + (src_color - dst.rgb) * src_alpha;
  } else {
    new_rgb = src_color;
  }

  return vec4<f32>(new_rgb, new_alpha);
}

// ============================================================================
// Compute Mask (matches brush.wgsl soft/hard brush logic)
// ============================================================================
fn compute_mask(dist: f32, radius: f32, hardness: f32) -> f32 {
  // Normalized distance (0-1 within radius, can exceed 1.0 for soft brushes)
  let normalized_dist = dist / radius;

  if (hardness >= 0.99) {
    // Hard brush: 1px anti-aliased edge
    // Early exit for pixels clearly outside
    if (dist > radius + 1.0) {
      return 0.0;
    }

    let pixel_size = 1.0 / radius;
    let half_pixel = pixel_size * 0.5;
    let edge_dist = normalized_dist - 1.0;

    if (edge_dist >= half_pixel) {
      return 0.0;
    } else if (edge_dist > -half_pixel) {
      return (half_pixel - edge_dist) / pixel_size;
    } else {
      return 1.0;
    }
  } else {
    // Soft brush: Gaussian (erf-based) falloff
    // NOTE: Do NOT early-exit here - Gaussian extends beyond radius!
    // The caller already did effective_radius culling.

    let fade = (1.0 - hardness) * 2.0;
    let safe_fade = max(0.001, fade);

    let SQRT_2 = 1.41421356;
    let center = (2.5 * (6761.0 * safe_fade - 10000.0)) / (SQRT_2 * 6761.0 * safe_fade);
    let alphafactor = 1.0 / (2.0 * erf_approx(center));

    // Distance factor for Gaussian falloff
    let distfactor = (SQRT_2 * 12500.0) / (6761.0 * safe_fade * radius);

    // Physical distance (use actual dist, not normalized * radius to avoid precision loss)
    let scaled_dist = dist * distfactor;
    let val = alphafactor * (erf_approx(scaled_dist + center) - erf_approx(scaled_dist - center));
    return saturate(val);
  }
}

// ============================================================================
// Calculate effective radius for soft brush (matches types.ts)
// ============================================================================
fn calculate_effective_radius(radius: f32, hardness: f32) -> f32 {
  if (hardness >= 0.99) {
    return radius;
  }
  let geometric_fade = (1.0 - hardness) * 2.5;
  return radius * max(1.5, 1.0 + geometric_fade);
}

// ============================================================================
// Main Compute Entry Point
// ============================================================================
@compute @workgroup_size(8, 8)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(local_invocation_index) local_idx: u32
) {
  // -------------------------------------------------------------------------
  // Step 1: Cooperatively load Dab data to Shared Memory
  // -------------------------------------------------------------------------
  let dabs_to_load = min(uniforms.dab_count, MAX_SHARED_DABS);
  if (local_idx == 0u) {
    shared_dab_count = dabs_to_load;
  }
  workgroupBarrier();

  // Each thread loads some dabs (64 threads / workgroup, up to 128 dabs)
  let threads_per_workgroup = 64u;
  var load_idx = local_idx;
  while (load_idx < dabs_to_load) {
    shared_dabs[load_idx] = dabs[load_idx];
    load_idx += threads_per_workgroup;
  }
  workgroupBarrier();

  // -------------------------------------------------------------------------
  // Step 2: Calculate actual pixel coordinates
  // -------------------------------------------------------------------------
  let local_x = gid.x;
  let local_y = gid.y;

  // Bounds check (only process pixels within bbox)
  if (local_x >= uniforms.bbox_size.x || local_y >= uniforms.bbox_size.y) {
    return;
  }

  let pixel_x = uniforms.bbox_offset.x + local_x;
  let pixel_y = uniforms.bbox_offset.y + local_y;

  // -------------------------------------------------------------------------
  // Step 3: Global bounds protection (prevent bbox calculation errors)
  // -------------------------------------------------------------------------
  if (pixel_x >= uniforms.canvas_size.x || pixel_y >= uniforms.canvas_size.y) {
    return;
  }

  let pixel = vec2<f32>(f32(pixel_x) + 0.5, f32(pixel_y) + 0.5); // Pixel center

  // -------------------------------------------------------------------------
  // Step 4: Read current pixel from INPUT texture
  // -------------------------------------------------------------------------
  var color = textureLoad(input_tex, vec2<i32>(i32(pixel_x), i32(pixel_y)), 0);

  // -------------------------------------------------------------------------
  // Step 5: Iterate all dabs, blend in order (read from shared memory)
  // -------------------------------------------------------------------------
  for (var i = 0u; i < shared_dab_count; i++) {
    let dab = shared_dabs[i];

    // Reconstruct vec2/vec3 from individual f32 fields
    let dab_center = vec2<f32>(dab.center_x, dab.center_y);
    let dab_color = vec3<f32>(dab.color_r, dab.color_g, dab.color_b);

    // Fast distance check (early culling)
    let effective_radius = calculate_effective_radius(dab.radius, dab.hardness);
    let dist = distance(pixel, dab_center);
    if (dist > effective_radius) {
      continue;
    }

    // Compute mask
    let mask = compute_mask(dist, dab.radius, dab.hardness);
    if (mask < 0.001) {
      continue;
    }

    let src_alpha = mask * dab.flow;

    // Alpha Darken blend
    color = alpha_darken_blend(color, dab_color, src_alpha, dab.dab_opacity);
  }

  // -------------------------------------------------------------------------
  // Step 6: Color space post-processing
  // -------------------------------------------------------------------------
  if (uniforms.color_blend_mode == 0u) {
    // sRGB mode: quantize to 8-bit to match Canvas 2D exactly
    color = vec4<f32>(
      quantize_to_8bit(color.r),
      quantize_to_8bit(color.g),
      quantize_to_8bit(color.b),
      quantize_to_8bit(color.a)
    );
  }

  // -------------------------------------------------------------------------
  // Step 7: Write to OUTPUT texture
  // -------------------------------------------------------------------------
  textureStore(output_tex, vec2<i32>(i32(pixel_x), i32(pixel_y)), color);
}

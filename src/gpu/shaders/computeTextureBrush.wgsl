// ============================================================================
// Compute Texture Brush Shader - Batch Rendering with Compute Shader
// ============================================================================
//
// This shader implements batched texture brush rendering using Compute Shader:
// - Single dispatch for all dabs in a batch (vs per-dab render passes)
// - Shared memory optimization for dab data
// - Manual bilinear interpolation (textureSampleLevel not available in compute)
// - Supports rotation, roundness, and aspect ratio transforms
//
// Performance target: Match parametric brush compute shader (~8-12ms for 64 dabs)
// ============================================================================

// ============================================================================
// Data Structures
// ============================================================================

// IMPORTANT: This struct must match the TypeScript packTextureDabData() layout exactly!
// Using individual f32 fields to avoid WGSL alignment issues.
// Total: 12 floats = 48 bytes per dab (no implicit padding)
struct TextureDabData {
  center_x: f32,          // Dab center X (offset 0)
  center_y: f32,          // Dab center Y (offset 4)
  size: f32,              // Dab diameter (offset 8)
  roundness: f32,         // Brush roundness 0-1 (offset 12)
  angle: f32,             // Rotation angle in radians (offset 16)
  color_r: f32,           // RGB color R (offset 20)
  color_g: f32,           // RGB color G (offset 24)
  color_b: f32,           // RGB color B (offset 28)
  dab_opacity: f32,       // Alpha Darken ceiling (offset 32)
  flow: f32,              // Flow multiplier (offset 36)
  tex_width: f32,         // Original texture width (offset 40)
  tex_height: f32,        // Original texture height (offset 44)
};

struct Uniforms {
  bbox_offset: vec2<u32>, // Bounding box top-left offset
  bbox_size: vec2<u32>,   // Bounding box size
  canvas_size: vec2<u32>, // Canvas actual size (for bounds protection)
  dab_count: u32,
  color_blend_mode: u32,  // 0 = sRGB (8-bit quantize), 1 = linear
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dabs: array<TextureDabData>;
@group(0) @binding(2) var input_tex: texture_2d<f32>;   // Read source (Ping)
@group(0) @binding(3) var output_tex: texture_storage_2d<rgba32float, write>; // Write target (Pong)
@group(0) @binding(4) var brush_texture: texture_2d<f32>;  // Brush tip texture

// ============================================================================
// Shared Memory Optimization: Cache Dab Data to Workgroup Shared Memory
// ============================================================================
const MAX_SHARED_DABS: u32 = 128u;
var<workgroup> shared_dabs: array<TextureDabData, MAX_SHARED_DABS>;
var<workgroup> shared_dab_count: u32;

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
// Manual Bilinear Interpolation for Texture Sampling
// Compute shaders cannot use textureSample(), so we implement bilinear manually
// ============================================================================
fn sample_texture_bilinear(tex: texture_2d<f32>, uv: vec2<f32>) -> f32 {
  let tex_dims = vec2<f32>(textureDimensions(tex));

  // Convert UV (0-1) to texel coordinates
  let texel_coord = uv * tex_dims - 0.5;

  // Get integer and fractional parts
  let texel_floor = floor(texel_coord);
  let frac = texel_coord - texel_floor;

  // Clamp to valid range
  let x0 = i32(clamp(texel_floor.x, 0.0, tex_dims.x - 1.0));
  let y0 = i32(clamp(texel_floor.y, 0.0, tex_dims.y - 1.0));
  let x1 = i32(clamp(texel_floor.x + 1.0, 0.0, tex_dims.x - 1.0));
  let y1 = i32(clamp(texel_floor.y + 1.0, 0.0, tex_dims.y - 1.0));

  // Sample 4 texels
  let s00 = textureLoad(tex, vec2<i32>(x0, y0), 0).r;
  let s10 = textureLoad(tex, vec2<i32>(x1, y0), 0).r;
  let s01 = textureLoad(tex, vec2<i32>(x0, y1), 0).r;
  let s11 = textureLoad(tex, vec2<i32>(x1, y1), 0).r;

  // Bilinear interpolation
  let top = mix(s00, s10, frac.x);
  let bottom = mix(s01, s11, frac.x);
  return mix(top, bottom, frac.y);
}

// ============================================================================
// Compute Texture Mask with Rotation, Roundness, and Aspect Ratio
// Transforms pixel position to UV space considering all brush parameters
// ============================================================================
fn compute_texture_mask(pixel: vec2<f32>, dab: TextureDabData) -> f32 {
  // 1. Calculate offset from dab center
  let offset = pixel - vec2<f32>(dab.center_x, dab.center_y);

  // 2. Inverse rotation (rotate pixel back to dab's local space)
  let cos_a = cos(-dab.angle);
  let sin_a = sin(-dab.angle);
  let rotated = vec2<f32>(
    offset.x * cos_a - offset.y * sin_a,
    offset.x * sin_a + offset.y * cos_a
  );

  // 3. Calculate half sizes considering texture aspect ratio
  let tex_aspect = dab.tex_width / dab.tex_height;
  var half_width: f32;
  var half_height: f32;

  if (tex_aspect >= 1.0) {
    // Wider than tall
    half_width = dab.size / 2.0;
    half_height = half_width / tex_aspect;
  } else {
    // Taller than wide
    half_height = dab.size / 2.0;
    half_width = half_height * tex_aspect;
  }

  // 4. Apply roundness (squeeze vertically in local space)
  half_height = half_height * dab.roundness;

  // 5. Normalize to UV space (0-1)
  // In local space: x in [-half_width, half_width], y in [-half_height, half_height]
  let normalized = vec2<f32>(
    rotated.x / half_width,
    rotated.y / half_height
  );

  // Convert from [-1, 1] to [0, 1]
  let uv = (normalized + 1.0) / 2.0;

  // 6. Bounds check - outside texture means no mask
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 0.0;
  }

  // 7. Sample texture with bilinear interpolation
  return sample_texture_bilinear(brush_texture, uv);
}

// ============================================================================
// Calculate effective bounding radius for early culling
// Must account for rotation (diagonal is longest)
// ============================================================================
fn calculate_effective_radius(dab: TextureDabData) -> f32 {
  let tex_aspect = dab.tex_width / dab.tex_height;
  var half_width: f32;
  var half_height: f32;

  if (tex_aspect >= 1.0) {
    half_width = dab.size / 2.0;
    half_height = half_width / tex_aspect;
  } else {
    half_height = dab.size / 2.0;
    half_width = half_height * tex_aspect;
  }

  half_height = half_height * dab.roundness;

  // After rotation, the bounding circle is the diagonal
  return sqrt(half_width * half_width + half_height * half_height);
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

    // Fast distance check for early culling
    let dab_center = vec2<f32>(dab.center_x, dab.center_y);
    let effective_radius = calculate_effective_radius(dab);
    let dist = distance(pixel, dab_center);
    if (dist > effective_radius + 1.0) {
      continue;
    }

    // Compute texture mask (with rotation/roundness/aspect transforms)
    let mask = compute_texture_mask(pixel, dab);
    if (mask < 0.001) {
      continue;
    }

    // Reconstruct color vec3 from individual f32 fields
    let dab_color = vec3<f32>(dab.color_r, dab.color_g, dab.color_b);
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

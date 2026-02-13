// ============================================================================
// Compute Texture Brush Shader - Batch Rendering with Compute Shader
// ============================================================================
//
// This shader implements batched texture brush rendering using Compute Shader:
// - Single dispatch for all dabs in a batch (vs per-dab render passes)
// - Shared memory optimization for dab data
// - Manual bilinear interpolation (textureSampleLevel not available in compute)
// - Supports rotation, roundness, and aspect ratio transforms
// - Supports Pattern Texture modulation (Canvas Space) with Blend Modes
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
  // Block 0
  bbox_offset: vec2<u32>, // Bounding box top-left offset
  bbox_size: vec2<u32>,   // Bounding box size

  // Block 1
  canvas_size: vec2<u32>, // Canvas actual size (for bounds protection)
  dab_count: u32,
  color_blend_mode: u32,  // 0 = sRGB (8-bit quantize), 1 = linear

  // Block 2: Pattern Settings
  pattern_enabled: u32,
  pattern_invert: u32,
  pattern_mode: u32,
  pattern_scale: f32,

  // Block 3
  pattern_brightness: f32,
  pattern_contrast: f32,
  pattern_depth: f32,
  pattern_each_tip: u32,

  // Block 4
  pattern_size: vec2<f32>,
  noise_enabled: u32,
  noise_strength: f32,
  noise_scale: f32,
  noise_size_jitter: f32,
  noise_density_jitter: f32,
  _noise_padding: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dabs: array<TextureDabData>;
@group(0) @binding(2) var input_tex: texture_2d<f32>;   // Read source (Ping)
@group(0) @binding(3) var output_tex: texture_storage_2d<rgba16float, write>; // Write target (Pong)
@group(0) @binding(4) var brush_texture: texture_2d<f32>;  // Brush tip texture
@group(0) @binding(5) var pattern_texture: texture_2d<f32>; // Pattern texture
@group(0) @binding(6) var noise_texture: texture_2d<f32>; // Noise texture (RGBA8, grayscale)

// ============================================================================
// Shared Memory Optimization: Cache Dab Data to Workgroup Shared Memory
// ============================================================================
const MAX_SHARED_DABS: u32 = 128u;
var<workgroup> shared_dabs: array<TextureDabData, MAX_SHARED_DABS>;
var<workgroup> shared_dab_count: u32;

// ============================================================================
// Quantize to 8-bit (kept consistent with parametric compute path)
// ============================================================================
fn quantize_to_8bit(val: f32) -> f32 {
  return floor(val * 255.0 + 0.5) / 255.0;
}

// ============================================================================
// Noise: Overlay on tip alpha (PS-like)
// ============================================================================
fn blend_overlay(base: f32, blend: f32) -> f32 {
  if (base < 0.5) {
    return 2.0 * base * blend;
  }
  return 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
}

fn hash12(p: vec2<f32>) -> f32 {
  let h = dot(p, vec2<f32>(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

fn sample_noise(pixel_x: u32, pixel_y: u32, dab_center: vec2<f32>) -> f32 {
  let dims = textureDimensions(noise_texture);
  if (dims.x == 0u || dims.y == 0u) {
    return 0.5;
  }

  let base_scale = max(0.1, uniforms.noise_scale);
  let size_jitter = clamp(uniforms.noise_size_jitter, 0.0, 1.0);
  let density_jitter = clamp(uniforms.noise_density_jitter, 0.0, 1.0);

  let size_rand = hash12(dab_center + vec2<f32>(17.0, 53.0)) * 2.0 - 1.0;
  let density_rand = hash12(dab_center + vec2<f32>(71.0, 19.0)) * 2.0 - 1.0;

  let jittered_scale = clamp(base_scale * (1.0 + size_rand * size_jitter), 0.1, 1000.0);
  // Keep grain-size mapping consistent with CPU noise path.
  let grain_px = max(1.0, jittered_scale);

  let sx = i32(floor(f32(pixel_x) / grain_px) * grain_px);
  let sy = i32(floor(f32(pixel_y) / grain_px) * grain_px);
  let w = i32(dims.x);
  let h = i32(dims.y);
  let nx = wrap_repeat_i32(sx, w);
  let ny = wrap_repeat_i32(sy, h);

  let sampled = textureLoad(noise_texture, vec2<i32>(nx, ny), 0).r;
  // Match CPU density jitter: randomize contrast per dab instead of linear bias.
  let jittered_contrast = density_rand * density_jitter * 50.0;
  let factor = pow((jittered_contrast + 100.0) / 100.0, 2.0);
  let contrasted = (sampled - 0.5) * factor + 0.5;
  return clamp(contrasted, 0.0, 1.0);
}

fn pattern_luma(color: vec4<f32>) -> f32 {
  return dot(color.rgb, vec3<f32>(0.299, 0.587, 0.114));
}

// ============================================================================
// Alpha Darken Blend (kept consistent with parametric compute path)
// ============================================================================
fn alpha_darken_blend(dst: vec4<f32>, src_color: vec3<f32>, src_alpha: f32, ceiling: f32) -> vec4<f32> {
  // Each dab can only raise alpha up to its own ceiling
  // Use max(dst.a, ceiling) as the effective ceiling for this dab
  let effective_ceiling = max(dst.a, ceiling);
  let alpha_headroom = effective_ceiling - dst.a;

  // Early stop: this dab has no contribution space
  if (alpha_headroom <= 0.001) {
    // Keep color blending when alpha is saturated to match CPU/parametric behavior
    if (src_alpha > 0.001 && dst.a > 0.001) {
      // CPU parity: color-only blend still uses src_alpha directly.
      // Multiplying by ceiling here exaggerates dab separation in low-ceiling modes (e.g. Subtract).
      let blend_factor = src_alpha;
      let new_rgb = dst.rgb + (src_color - dst.rgb) * blend_factor;
      return vec4<f32>(new_rgb, dst.a);
    }
    return dst;
  }

  let new_alpha = min(1.0, dst.a + alpha_headroom * src_alpha);

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

  // Clamp to valid range (Clamp to Edge)
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
// Pattern Sampling (CPU parity):
// - Canvas-space nearest sample
// - floor(pixel * (100 / scale))
// - repeat wrap
// ============================================================================
fn wrap_repeat_i32(v: i32, size: i32) -> i32 {
  return (v % size + size) % size;
}

fn sample_pattern_cpu_parity(tex: texture_2d<f32>, pixel_xy: vec2<u32>, scale: f32) -> f32 {
  let dims = textureDimensions(tex);
  if (dims.x == 0u || dims.y == 0u) {
    return 1.0;
  }

  let safe_scale = max(1.0, scale);
  let scale_factor = 100.0 / safe_scale;

  let sx = i32(floor(f32(pixel_xy.x) * scale_factor));
  let sy = i32(floor(f32(pixel_xy.y) * scale_factor));

  let w = i32(dims.x);
  let h = i32(dims.y);
  let tx = wrap_repeat_i32(sx, w);
  let ty = wrap_repeat_i32(sy, h);

  return pattern_luma(textureLoad(tex, vec2<i32>(tx, ty), 0));
}

// ============================================================================
// Apply Blend Mode (Standard Photoshop Modes)
// Base: Tip alpha (mask)
// Blend: Pattern texture value
// ============================================================================
fn is_depth_embedded_mode(mode: u32) -> bool {
  return mode == 7u || mode == 8u || mode == 9u;
}

fn blend_hard_mix_softer_photoshop(base: f32, blend: f32, depth: f32) -> f32 {
  // Krita Hard Mix Softer (Photoshop), non-soft-texturing branch:
  // out = clamp(3 * (base * depth) - 2 * (1 - blend), 0, 1)
  return clamp(3.0 * base * depth - 2.0 * (1.0 - blend), 0.0, 1.0);
}

fn blend_linear_height_photoshop(base: f32, blend: f32, depth: f32) -> f32 {
  // Krita Linear Height (Photoshop):
  // M = 10 * depth * base
  // out = clamp(max((1 - blend) * M, M - blend), 0, 1)
  let m = 10.0 * depth * base;
  return clamp(max((1.0 - blend) * m, m - blend), 0.0, 1.0);
}

fn blend_height_photoshop(base: f32, blend: f32, depth: f32) -> f32 {
  // Krita Height (Photoshop):
  // out = clamp(10 * depth * base - blend, 0, 1)
  return clamp(10.0 * depth * base - blend, 0.0, 1.0);
}

fn apply_blend_mode(base: f32, blend: f32, mode: u32, depth: f32) -> f32 {
  switch (mode) {
    case 0u: { // Multiply
      return base * blend;
    }
    case 1u: { // Subtract
      // Use proportional subtraction (base * (1 - blend)) to avoid
      // low-alpha dab regions being over-subtracted and revealing dab seams.
      return base * (1.0 - blend);
    }
    case 2u: { // Darken
      return min(base, blend);
    }
    case 3u: { // Overlay
      if (base < 0.5) {
        return 2.0 * base * blend;
      }
      return 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
    }
    case 4u: { // Color Dodge
      if (blend >= 1.0) { return 1.0; }
      return min(1.0, base / (1.0 - blend));
    }
    case 5u: { // Color Burn
      if (blend <= 0.0) { return 0.0; }
      return 1.0 - min(1.0, (1.0 - base) / blend);
    }
    case 6u: { // Linear Burn
      return max(0.0, base + blend - 1.0);
    }
    case 7u: { // Hard Mix
      return blend_hard_mix_softer_photoshop(base, blend, depth);
    }
    case 8u: { // Linear Height
      return blend_linear_height_photoshop(base, blend, depth);
    }
    case 9u: { // Height
      return blend_height_photoshop(base, blend, depth);
    }
    default: { // Default / Multiply
      return base * blend;
    }
  }
}

// ============================================================================
// Calculate Pattern Modulation (Returns Alpha Darken ceiling multiplier)
// ============================================================================
fn calculate_pattern_multiplier(
  pixel_xy: vec2<u32>,
  base_mask: f32,
  accumulated_alpha: f32
) -> f32 {
  // Use accumulated alpha as an additional base so non-linear blend modes
  // follow continuous stroke buildup instead of isolated dab masks.
  let base = max(clamp(base_mask, 0.0, 1.0), clamp(accumulated_alpha, 0.0, 1.0));
  if (base <= 0.001) {
    return 0.0;
  }

  let depth = clamp(uniforms.pattern_depth / 100.0, 0.0, 1.0);
  if (depth <= 0.001) {
    return 1.0;
  }

  // 1. Sample Pattern (CPU parity nearest sampling in canvas space)
  var tex_val = sample_pattern_cpu_parity(pattern_texture, pixel_xy, uniforms.pattern_scale);

  // 3. Apply Adjustments
  if (uniforms.pattern_invert > 0u) {
    tex_val = 1.0 - tex_val;
  }

  // Brightness
  if (abs(uniforms.pattern_brightness) > 0.001) {
    tex_val = tex_val - uniforms.pattern_brightness / 255.0;
  }

  // Contrast
  if (abs(uniforms.pattern_contrast) > 0.001) {
    let contrast_factor = pow((uniforms.pattern_contrast + 100.0) / 100.0, 2.0);
    tex_val = (tex_val - 0.5) * contrast_factor + 0.5;
  }

  tex_val = clamp(tex_val, 0.0, 1.0);

  // 4. Apply Blend Mode
  let blended_mask = apply_blend_mode(base, tex_val, uniforms.pattern_mode, depth);

  // 5. Apply Depth (Strength)
  // Hard Mix Softer / Linear Height / Height already include depth in the formula.
  let target_mask = select(
    clamp(mix(base, blended_mask, depth), 0.0, 1.0),
    blended_mask,
    is_depth_embedded_mode(uniforms.pattern_mode)
  );

  // Return multiplier relative to base mask (may exceed 1.0 for some modes)
  return target_mask / base;
}

// ============================================================================
// Calculate half dimensions considering texture aspect ratio and roundness
// ============================================================================
fn calculate_half_dimensions(dab: TextureDabData) -> vec2<f32> {
  let safe_tex_w = max(dab.tex_width, 1.0);
  let safe_tex_h = max(dab.tex_height, 1.0);
  let tex_aspect = safe_tex_w / safe_tex_h;
  var half_width: f32;
  var half_height: f32;

  if (tex_aspect >= 1.0) {
    half_width = dab.size / 2.0;
    half_height = half_width / tex_aspect;
  } else {
    half_height = dab.size / 2.0;
    half_width = half_height * tex_aspect;
  }

  return vec2<f32>(half_width, half_height * dab.roundness);
}

// ============================================================================
// Compute Texture Mask with Rotation, Roundness, and Aspect Ratio
// Transforms pixel position to UV space considering all brush parameters
// ============================================================================
fn compute_texture_mask(pixel: vec2<f32>, dab: TextureDabData) -> f32 {
  let offset = pixel - vec2<f32>(dab.center_x, dab.center_y);

  // Inverse rotation (rotate pixel back to dab's local space)
  let cos_a = cos(-dab.angle);
  let sin_a = sin(-dab.angle);
  let rotated = vec2<f32>(
    offset.x * cos_a - offset.y * sin_a,
    offset.x * sin_a + offset.y * cos_a
  );

  let half_dims = calculate_half_dimensions(dab);
  let radius = dab.size / 2.0;

  // =========================================================================
  // SMALL BRUSH OPTIMIZATION (applies to ALL hardness levels)
  // =========================================================================
  // For very small brushes (size < 6px, radius < 3px), use Gaussian spot model
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

  // =========================================================================
  // NORMAL SIZE BRUSHES (radius >= 3px) - Full texture sampling
  // =========================================================================
  let normalized = rotated / half_dims;
  let uv = (normalized + 1.0) / 2.0;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 0.0;
  }

  return sample_texture_bilinear(brush_texture, uv);
}

// ============================================================================
// Calculate effective bounding radius for early culling
// After rotation, the bounding circle is the diagonal
// ============================================================================
fn calculate_effective_radius(dab: TextureDabData) -> f32 {
  let half_dims = calculate_half_dimensions(dab);
  return length(half_dims);
}

// ============================================================================
// Main Compute Entry Point
// ============================================================================
@compute @workgroup_size(8, 8)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
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

    // A. Compute Tip Mask (Tip Shape)
    var mask = compute_texture_mask(pixel, dab);
    if (mask < 0.001) {
      continue;
    }

    // A2. Texture:
    // - textureEachTip=true  => per-dab texture modulation
    // - textureEachTip=false => stroke-level modulation (applied once after dab loop)
    var pattern_mult = 1.0;
    if (uniforms.pattern_enabled != 0u && uniforms.pattern_each_tip != 0u) {
       pattern_mult = calculate_pattern_multiplier(vec2<u32>(pixel_x, pixel_y), mask, color.a);
    }

    // A3. Noise: overlay on tip alpha, only meaningful on soft edge (0<alpha<1)
    if (uniforms.noise_enabled != 0u && mask > 0.001 && mask < 0.999) {
      let noise_val = sample_noise(pixel_x, pixel_y, vec2<f32>(dab.center_x, dab.center_y));
      let over = blend_overlay(mask, noise_val);
      mask = mix(mask, over, clamp(uniforms.noise_strength, 0.0, 1.0));
    }

    let ceiling = dab.dab_opacity * pattern_mult;

    // Reconstruct color vec3 from individual f32 fields
    let dab_color = vec3<f32>(dab.color_r, dab.color_g, dab.color_b);
    let src_alpha = mask * dab.flow;

    // Alpha Darken blend
    color = alpha_darken_blend(color, dab_color, src_alpha, ceiling);
  }

  // Stroke-level texture blend (Texture Each Tip = OFF):
  // run only in dedicated post pass (dab_count == 0) to avoid destructive re-modulation
  // across multiple flushes within a single stroke.
  if (uniforms.pattern_enabled != 0u && uniforms.pattern_each_tip == 0u && uniforms.dab_count == 0u) {
    let stroke_pattern_mult = calculate_pattern_multiplier(
      vec2<u32>(pixel_x, pixel_y),
      color.a,
      color.a
    );
    color = vec4<f32>(color.rgb, clamp(color.a * stroke_pattern_mult, 0.0, 1.0));
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

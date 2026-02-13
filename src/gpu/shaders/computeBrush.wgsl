// ============================================================================
// Compute Brush Shader - Batch Rendering with Compute Shader
// ============================================================================
//
// This shader implements batched dab rendering using Compute Shader:
// - Single dispatch for all dabs in a batch (vs per-dab render passes)
// - Shared memory optimization for dab data
// - Only processes pixels within the bounding box
// - Alpha Darken blending (kept consistent with legacy render-path behavior)
// - Pattern Texture Modulation (Matches computeTextureBrush.wgsl)
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
  roundness: f32,         // Brush roundness 0.01-1.0 (offset 36)
  angle_cos: f32,         // cos(angle), precomputed on CPU (offset 40)
  angle_sin: f32,         // sin(angle), precomputed on CPU (offset 44)
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
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dabs: array<DabData>;
@group(0) @binding(2) var input_tex: texture_2d<f32>;   // Read source (Ping)
@group(0) @binding(3) var output_tex: texture_storage_2d<rgba16float, write>; // Write target (Pong)
@group(0) @binding(4) var<storage, read> gaussian_table: array<f32>;  // Gaussian LUT
@group(0) @binding(5) var pattern_texture: texture_2d<f32>; // Pattern texture
@group(0) @binding(6) var noise_texture: texture_2d<f32>; // Noise texture (RGBA8, grayscale)

// ============================================================================
// Shared Memory Optimization: Cache Dab Data to Workgroup Shared Memory
// ============================================================================
const MAX_SHARED_DABS: u32 = 128u;
var<workgroup> shared_dabs: array<DabData, MAX_SHARED_DABS>;
var<workgroup> shared_dab_count: u32;

// ============================================================================
// Error Function Approximation
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
// Quantize to 8-bit
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

fn sample_noise(pixel_x: u32, pixel_y: u32) -> f32 {
  let dims = textureDimensions(noise_texture);
  if (dims.x == 0u || dims.y == 0u) {
    return 0.5;
  }

  let nx = pixel_x % dims.x;
  let ny = pixel_y % dims.y;
  return textureLoad(noise_texture, vec2<i32>(i32(nx), i32(ny)), 0).r;
}

fn pattern_luma(color: vec4<f32>) -> f32 {
  return dot(color.rgb, vec3<f32>(0.299, 0.587, 0.114));
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
// Alpha Darken Blend
// ============================================================================
fn alpha_darken_blend(dst: vec4<f32>, src_color: vec3<f32>, src_alpha: f32, ceiling: f32) -> vec4<f32> {
  // Each dab can only raise alpha up to its own ceiling
  // Use max(dst.a, ceiling) as the effective ceiling for this dab
  let effective_ceiling = max(dst.a, ceiling);
  let alpha_headroom = effective_ceiling - dst.a;

  // Early stop: this dab has no contribution space
  if (alpha_headroom <= 0.001) {
    // But we still need to blend the color ON TOP even if alpha doesn't increase
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
// Compute Mask
// ============================================================================
const HARD_BRUSH_THRESHOLD: f32 = 0.99;
const SOFT_MASK_MAX_EXTENT: f32 = 1.8;
const SOFT_MASK_EXPONENT: f32 = 2.3;
const SOFT_MASK_FEATHER_WIDTH: f32 = 0.3;

fn compute_mask(dist: f32, radius: f32, hardness: f32) -> f32 {
  // Keep hard-brush AA behavior unchanged.
  if (hardness >= HARD_BRUSH_THRESHOLD) {
    return 1.0 - smoothstep(radius - 0.5, radius + 0.5, dist);
  }

  // Match CPU MaskCache gaussian profile:
  // 1) hardness-controlled solid core
  // 2) exponential falloff outside the core
  // 3) terminal feather near max extent to avoid clipping
  let safe_radius = max(radius, 1e-6);
  let norm_dist = dist / safe_radius;

  if (norm_dist > SOFT_MASK_MAX_EXTENT) {
    return 0.0;
  }
  if (norm_dist <= hardness) {
    return 1.0;
  }

  let denom = max(1e-6, 1.0 - hardness);
  let t = (norm_dist - hardness) / denom;
  var alpha = exp(-SOFT_MASK_EXPONENT * t * t);

  let feather_start = max(1.0, SOFT_MASK_MAX_EXTENT - SOFT_MASK_FEATHER_WIDTH);
  if (norm_dist > feather_start) {
    let fade_out = 1.0 - smoothstep(feather_start, SOFT_MASK_MAX_EXTENT, norm_dist);
    alpha = alpha * fade_out;
  }

  return saturate(alpha);
}

// ============================================================================
// Calculate effective radius (unified for all hardness levels)
// ============================================================================
fn calculate_effective_radius(radius: f32, hardness: f32) -> f32 {
  if (radius < 2.0) {
    return max(1.5, radius + 1.0);
  }
  if (hardness >= HARD_BRUSH_THRESHOLD) {
    return radius * 1.1;
  }
  // Must track CPU soft-brush extent (MaskCache.SOFT_MAX_EXTENT).
  return radius * SOFT_MASK_MAX_EXTENT;
}

// ============================================================================
// Compute ellipse distance (handles roundness and rotation)
// ============================================================================
fn compute_ellipse_distance(pixel: vec2<f32>, dab: DabData) -> f32 {
  let delta = pixel - vec2<f32>(dab.center_x, dab.center_y);

  // Inverse rotation to dab's local space (using CPU-precomputed cos/sin)
  let rotated_x = delta.x * dab.angle_cos + delta.y * dab.angle_sin;
  let rotated_y = delta.y * dab.angle_cos - delta.x * dab.angle_sin;

  let scaled_y = rotated_y / dab.roundness;

  return sqrt(rotated_x * rotated_x + scaled_y * scaled_y);
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

    // Fast distance check (early culling) - use simple Euclidean distance
    // Since roundness <= 1.0, ellipse is always inside the circle
    let effective_radius = calculate_effective_radius(dab.radius, dab.hardness);
    let quick_dist = distance(pixel, dab_center);
    if (quick_dist > effective_radius) {
      continue;
    }

    // Compute ellipse distance (with rotation and roundness)
    let dist = compute_ellipse_distance(pixel, dab);

    // Compute mask using ellipse distance
    var mask = compute_mask(dist, dab.radius, dab.hardness);
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
      let noise_val = sample_noise(pixel_x, pixel_y);
      let over = blend_overlay(mask, noise_val);
      mask = mix(mask, over, clamp(uniforms.noise_strength, 0.0, 1.0));
    }

    let ceiling = dab.dab_opacity * pattern_mult;
    let src_alpha = mask * dab.flow;

    // Alpha Darken blend
    color = alpha_darken_blend(color, dab_color, src_alpha, ceiling);
  }

  // Stroke-level texture blend (Photoshop-like when Texture Each Tip is OFF):
  // apply texture modulation once to the accumulated stroke alpha.
  if (uniforms.pattern_enabled != 0u && uniforms.pattern_each_tip == 0u) {
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

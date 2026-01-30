// ============================================================================
// Compute Brush Shader - Batch Rendering with Compute Shader
// ============================================================================
//
// This shader implements batched dab rendering using Compute Shader:
// - Single dispatch for all dabs in a batch (vs per-dab render passes)
// - Shared memory optimization for dab data
// - Only processes pixels within the bounding box
// - Alpha Darken blending (matches brush.wgsl exactly)
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
  pattern_padding: u32,

  // Block 4
  pattern_size: vec2<f32>,
  padding2: vec2<u32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dabs: array<DabData>;
@group(0) @binding(2) var input_tex: texture_2d<f32>;   // Read source (Ping)
@group(0) @binding(3) var output_tex: texture_storage_2d<rgba32float, write>; // Write target (Pong)
@group(0) @binding(4) var<storage, read> gaussian_table: array<f32>;  // Gaussian LUT
@group(0) @binding(5) var pattern_texture: texture_2d<f32>; // Pattern texture

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
// Pattern Sampling with Tiling (Repeat)
// ============================================================================
fn sample_pattern_tiled(tex: texture_2d<f32>, uv: vec2<f32>) -> f32 {
  let tex_dims = vec2<f32>(textureDimensions(tex));

  // Wrap UV (Repeat)
  let wrapped_uv = fract(uv);

  // Reuse bilinear sampling logic but with wrapped UVs handled by fract()
  // Note: Standard bilinear needs neighbors. Manual wrap:
  let texel_coord = wrapped_uv * tex_dims - 0.5;
  let texel_floor = floor(texel_coord);
  let frac = texel_coord - texel_floor;

  // Custom wrap logic for neighbor sampling
  let w = i32(tex_dims.x);
  let h = i32(tex_dims.y);

  let x0 = (i32(texel_floor.x) % w + w) % w;
  let y0 = (i32(texel_floor.y) % h + h) % h;
  let x1 = (x0 + 1) % w;
  let y1 = (y0 + 1) % h;

  let s00 = textureLoad(tex, vec2<i32>(x0, y0), 0).r;
  let s10 = textureLoad(tex, vec2<i32>(x1, y0), 0).r;
  let s01 = textureLoad(tex, vec2<i32>(x0, y1), 0).r;
  let s11 = textureLoad(tex, vec2<i32>(x1, y1), 0).r;

  let top = mix(s00, s10, frac.x);
  let bottom = mix(s01, s11, frac.x);
  return mix(top, bottom, frac.y);
}

// ============================================================================
// Apply Blend Mode (Standard Photoshop Modes)
// Base: Brush Ceiling (dab_opacity)
// Blend: Pattern Texture Value
// ============================================================================
fn apply_blend_mode(base: f32, blend: f32, mode: u32) -> f32 {
  switch (mode) {
    case 0u: { // Multiply
      return base * blend;
    }
    case 1u: { // Subtract
      return max(0.0, base - blend);
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
      if (base + blend >= 1.0) { return 1.0; }
      return 0.0;
    }
    default: { // Default / Multiply
      return base * blend;
    }
  }
}

// ============================================================================
// Calculate Pattern Ceiling Modulation (Modifies Alpha Darken Ceiling)
// ============================================================================
fn calculate_pattern_ceiling(
  pixel: vec2<f32>,
  base_ceiling: f32
) -> f32 {
  // 1. Calculate Canvas Space UV
  let scale = max(0.1, uniforms.pattern_scale);
  let scale_factor = uniforms.pattern_size * (scale / 100.0);
  let uv = pixel / scale_factor;

  // 2. Sample Pattern (Tiled)
  var tex_val = sample_pattern_tiled(pattern_texture, uv);

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
  // Base is the current ceiling (dab_opacity)
  let blended_ceiling = apply_blend_mode(base_ceiling, tex_val, uniforms.pattern_mode);

  // 5. Apply Depth (Strength)
  let depth = clamp(uniforms.pattern_depth / 100.0, 0.0, 1.0);

  return mix(base_ceiling, blended_ceiling, depth);
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
      // Color-only blend: new dab paints on top
      let blend_factor = src_alpha * ceiling;  // Weighted by dab's opacity
      let new_rgb = dst.rgb + (src_color - dst.rgb) * blend_factor;
      return vec4<f32>(new_rgb, dst.a);
    }
    return dst;
  }

  let new_alpha = dst.a + alpha_headroom * src_alpha;

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
fn compute_mask(dist: f32, radius: f32, hardness: f32) -> f32 {
  // =========================================================================
  // SMALL BRUSH OPTIMIZATION (applies to ALL hardness levels)
  // =========================================================================
  // For very small brushes (radius < 3px), use Gaussian spot model
  let SMALL_BRUSH_THRESHOLD = 3.0;

  if (radius < SMALL_BRUSH_THRESHOLD) {
    let base_sigma = max(radius, 0.5);
    let softness_factor = 1.0 + (1.0 - hardness);
    let sigma = base_sigma * softness_factor;

    var alpha = exp(-(dist * dist) / (2.0 * sigma * sigma));

    if (hardness >= 0.99 && radius >= 1.5) {
      let blend = (radius - 1.5) / 1.5;
      let edge_dist = radius;
      let sharp_alpha = 1.0 - smoothstep(edge_dist - 0.5, edge_dist + 0.5, dist);
      alpha = mix(alpha, sharp_alpha, blend * hardness);
    }

    return min(1.0, alpha);
  }

  // =========================================================================
  // NORMAL SIZE BRUSHES (radius >= 3px)
  // =========================================================================
  if (hardness >= 0.99) {
    return 1.0 - smoothstep(radius - 0.5, radius + 0.5, dist);
  } else {
    let fade = (1.0 - hardness) * 2.0;
    let safe_fade = max(0.001, fade);

    let SQRT_2 = 1.41421356;
    let center = (2.5 * (6761.0 * safe_fade - 10000.0)) / (SQRT_2 * 6761.0 * safe_fade);
    let alphafactor = 1.0 / (2.0 * erf_approx(center));

    let distfactor = (SQRT_2 * 12500.0) / (6761.0 * safe_fade * radius);

    let scaled_dist = dist * distfactor;
    let val = alphafactor * (erf_approx(scaled_dist + center) - erf_approx(scaled_dist - center));
    return saturate(val);
  }
}

// ============================================================================
// Calculate effective radius (unified for all hardness levels)
// ============================================================================
fn calculate_effective_radius(radius: f32, hardness: f32) -> f32 {
  if (radius < 2.0) {
    return max(1.5, radius + 1.0);
  }
  let geometric_fade = (1.0 - hardness) * 2.5;
  return radius * max(1.1, 1.0 + geometric_fade);
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
    let mask = compute_mask(dist, dab.radius, dab.hardness);
    if (mask < 0.001) {
      continue;
    }

    // B. Calculate Dynamic Ceiling (Pattern Modulation) for Parametric Brushes
    var ceiling = dab.dab_opacity;
    if (uniforms.pattern_enabled != 0u) {
       ceiling = calculate_pattern_ceiling(pixel, ceiling);
    }

    let src_alpha = mask * dab.flow;

    // Alpha Darken blend
    color = alpha_darken_blend(color, dab_color, src_alpha, ceiling);
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

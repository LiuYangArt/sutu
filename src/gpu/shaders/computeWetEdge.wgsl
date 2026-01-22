// ============================================================================
// Wet Edge Post-Processing Shader
// ============================================================================
//
// Stroke-level alpha remapping for wet edge effect.
// This shader is applied AFTER dab rendering completes, as a display filter.
//
// Key design: This is a READ-ONLY filter on the raw accumulator buffer.
// It writes to a SEPARATE display texture to avoid idempotency issues.
// (Applying wet edge multiple times would cause Alpha = f(f(Alpha)) corruption)
//
// Algorithm matches CPU strokeBuffer.ts:buildWetEdgeLut() exactly:
// - centerOpacity = 0.65 (center keeps 65% of original opacity)
// - maxBoost = 1.8 (maximum edge boost for soft brushes)
// - minBoost = 1.4 (minimum boost for hard brushes)
// - hardness threshold = 0.7 (transition zone)
// - gamma = 1.3 (for soft brushes, skipped for hard brushes to preserve AA)
//
// ============================================================================

// ============================================================================
// Data Structures
// ============================================================================

struct Uniforms {
  bbox_offset: vec2<u32>,   // Dirty rect top-left (in texture coordinates)
  bbox_size: vec2<u32>,     // Dirty rect size
  canvas_size: vec2<u32>,   // Full canvas size (for bounds protection)
  hardness: f32,            // Brush hardness (0-1)
  strength: f32,            // Wet edge strength (0-1)
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var input_tex: texture_2d<f32>;   // Raw accumulator (read-only)
@group(0) @binding(2) var output_tex: texture_storage_2d<rgba32float, write>; // Display output

// ============================================================================
// Wet Edge Alpha Calculation
// ============================================================================
// Matches CPU strokeBuffer.ts:buildWetEdgeLut() exactly
// This is computed per-pixel instead of using LUT (GPU is fast enough)

fn compute_wet_edge_alpha(original_alpha: f32, hardness: f32, strength: f32) -> f32 {
  // Photoshop-matched parameters (from CPU implementation)
  let center_opacity = 0.65; // Center keeps 65% of original opacity
  let max_boost = 1.8;       // Maximum edge boost for soft brushes
  let min_boost = 1.4;       // Minimum boost for hard brushes

  // Dynamic edgeBoost based on hardness (v4 core algorithm)
  // - hardness < 0.7: full wet edge effect
  // - hardness 0.7-1.0: gradual fade to minBoost
  var effective_boost: f32;
  if (hardness > 0.7) {
    // Transition zone: smooth interpolation
    let t = (hardness - 0.7) / 0.3; // 0.0 -> 1.0
    effective_boost = max_boost * (1.0 - t) + min_boost * t;
  } else {
    // Soft brushes: full wet edge effect
    effective_boost = max_boost;
  }

  // Gamma shaping: skip for hard brushes to preserve original AA gradient
  // This is critical for preventing "black halo" aliasing on hard brushes
  let shaped_alpha = select(
    pow(original_alpha, 1.3),  // Soft brush: apply gamma 1.3
    original_alpha,             // Hard brush: no gamma (preserve AA)
    hardness > 0.7
  );

  // Core tone mapping: edge (low alpha) -> boost, center (high alpha) -> fade
  let multiplier = effective_boost - (effective_boost - center_opacity) * shaped_alpha;
  var wet_alpha = original_alpha * multiplier;

  // Blend with original based on strength
  wet_alpha = original_alpha * (1.0 - strength) + wet_alpha * strength;

  return min(1.0, wet_alpha);
}

// ============================================================================
// Main Compute Entry Point
// ============================================================================

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let local_x = gid.x;
  let local_y = gid.y;

  // Bounds check (only process pixels within bbox)
  if (local_x >= uniforms.bbox_size.x || local_y >= uniforms.bbox_size.y) {
    return;
  }

  let pixel_x = uniforms.bbox_offset.x + local_x;
  let pixel_y = uniforms.bbox_offset.y + local_y;

  // Canvas bounds protection
  if (pixel_x >= uniforms.canvas_size.x || pixel_y >= uniforms.canvas_size.y) {
    return;
  }

  let coord = vec2<i32>(i32(pixel_x), i32(pixel_y));

  // Read current pixel from raw accumulator
  let color = textureLoad(input_tex, coord, 0);

  // Early exit for transparent pixels (1/255 threshold)
  // This is a significant optimization for typical strokes
  if (color.a < 0.004) {
    textureStore(output_tex, coord, color);
    return;
  }

  // Compute wet edge alpha remapping
  let wet_alpha = compute_wet_edge_alpha(color.a, uniforms.hardness, uniforms.strength);

  // Write result: RGB unchanged, only alpha modified
  textureStore(output_tex, coord, vec4<f32>(color.rgb, wet_alpha));
}

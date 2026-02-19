// ============================================================================
// Compute Dual Blend Shader - Stroke-level Dual Brush Alpha Modulation
// ============================================================================
//
// Reads primary stroke color (rgba16float) and secondary mask (.r),
// applies PS-compatible dual blend mode, and writes modified alpha only.
// ============================================================================

struct Uniforms {
  bbox_offset: vec2<u32>,
  bbox_size: vec2<u32>,
  canvas_size: vec2<u32>,
  blend_mode: u32,
  padding: u32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var primary_tex: texture_2d<f32>;
@group(0) @binding(2) var dual_tex: texture_2d<f32>;
@group(0) @binding(3) var output_tex: texture_storage_2d<rgba16float, write>;

fn blend_dual(primary: f32, secondary: f32, mode: u32) -> f32 {
  let p = clamp(primary, 0.0, 1.0);
  let s = clamp(secondary, 0.0, 1.0);

  switch (mode) {
    case 0u: { // Multiply
      return p * s;
    }
    case 1u: { // Darken
      return min(p, s);
    }
    case 2u: { // Overlay
      if (p < 0.5) {
        return 2.0 * p * s;
      }
      return 1.0 - 2.0 * (1.0 - p) * (1.0 - s);
    }
    case 3u: { // Color Dodge
      if (s >= 1.0) { return 1.0; }
      return min(1.0, p / (1.0 - s));
    }
    case 4u: { // Color Burn
      if (s <= 0.0) { return 0.0; }
      return max(0.0, 1.0 - (1.0 - p) / s);
    }
    case 5u: { // Linear Burn
      return max(0.0, p + s - 1.0);
    }
    case 6u: { // Hard Mix
      return clamp(3.0 * p - 2.0 * (1.0 - s), 0.0, 1.0);
    }
    case 7u: { // Linear Height
      let m = 10.0 * p;
      return clamp(max((1.0 - s) * m, m - s), 0.0, 1.0);
    }
    default: { // Multiply
      return p * s;
    }
  }
}

fn dual_mode_allows_alpha_lift(mode: u32) -> bool {
  return mode == 2u || mode == 3u || mode == 6u || mode == 7u;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
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

  let coord = vec2<i32>(i32(pixel_x), i32(pixel_y));
  let primary = textureLoad(primary_tex, coord, 0);
  let secondary = textureLoad(dual_tex, coord, 0).r;

  if (primary.a < 0.001 && secondary < 0.001) {
    textureStore(output_tex, coord, primary);
    return;
  }

  if (primary.a > 0.001) {
    let blended = blend_dual(primary.a, secondary, uniforms.blend_mode);
    let ratio = blended / primary.a;
    let allow_lift = dual_mode_allows_alpha_lift(uniforms.blend_mode);
    let clamped_alpha = primary.a * clamp(ratio, 0.0, 1.0);
    let lifted_alpha = blended;
    let new_alpha = clamp(
      select(clamped_alpha, lifted_alpha, allow_lift),
      0.0,
      1.0
    );
    textureStore(output_tex, coord, vec4<f32>(primary.rgb, new_alpha));
    return;
  }

  textureStore(output_tex, coord, primary);
}

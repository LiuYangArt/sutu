struct Uniforms {
  canvas_size: vec2<u32>,
  tile_origin: vec2<u32>,
  _pad0: vec4<u32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var dst_tex: texture_2d<f32>;
@group(0) @binding(2) var selection_tex: texture_2d<f32>;
@group(0) @binding(3) var lut_rgb: texture_2d<f32>;
@group(0) @binding(4) var lut_red: texture_2d<f32>;
@group(0) @binding(5) var lut_green: texture_2d<f32>;
@group(0) @binding(6) var lut_blue: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VertexOut {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(1.0, 1.0)
  );

  var out: VertexOut;
  out.position = vec4<f32>(positions[vid], 0.0, 1.0);
  return out;
}

fn sample_lut(lut: texture_2d<f32>, value: f32) -> f32 {
  let scaled = clamp(value, 0.0, 1.0) * 255.0;
  let idx = i32(round(scaled));
  return textureLoad(lut, vec2<i32>(idx, 0), 0).r;
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let local_x = u32(position.x);
  let local_y = u32(position.y);

  let canvas_x = uniforms.tile_origin.x + local_x;
  let canvas_y = uniforms.tile_origin.y + local_y;

  let dst = textureLoad(dst_tex, vec2<i32>(i32(local_x), i32(local_y)), 0);
  let selection = textureLoad(selection_tex, vec2<i32>(i32(canvas_x), i32(canvas_y)), 0).r;
  if (selection <= 0.0) {
    return dst;
  }

  let channel_r = sample_lut(lut_red, dst.r);
  let channel_g = sample_lut(lut_green, dst.g);
  let channel_b = sample_lut(lut_blue, dst.b);
  let mapped = vec3<f32>(
    sample_lut(lut_rgb, channel_r),
    sample_lut(lut_rgb, channel_g),
    sample_lut(lut_rgb, channel_b)
  );

  let mixed = mix(dst.rgb, mapped, clamp(selection, 0.0, 1.0));
  return vec4<f32>(mixed, dst.a);
}

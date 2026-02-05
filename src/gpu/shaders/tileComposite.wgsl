struct Uniforms {
  canvas_size: vec2<u32>,
  tile_origin: vec2<u32>,
  position_origin: vec2<u32>,
  stroke_opacity: f32,
  apply_dither: u32,
  dither_strength: f32,
  render_scale: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var layer_tex: texture_2d<f32>;
@group(0) @binding(2) var scratch_tex: texture_2d<f32>;
@group(0) @binding(3) var selection_tex: texture_2d<f32>;

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

fn bayer4x4(x: u32, y: u32) -> f32 {
  let xi = x & 3u;
  let yi = y & 3u;
  let idx = yi * 4u + xi;
  let table = array<f32, 16>(
    0.0, 8.0, 2.0, 10.0,
    12.0, 4.0, 14.0, 6.0,
    3.0, 11.0, 1.0, 9.0,
    15.0, 7.0, 13.0, 5.0
  );
  return (table[idx] / 16.0) - 0.5;
}

fn apply_dither(color: vec3<f32>, x: u32, y: u32, strength: f32) -> vec3<f32> {
  let dither = bayer4x4(x, y) * (strength / 255.0);
  return clamp(color + vec3<f32>(dither, dither, dither), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let pos_u = vec2<u32>(u32(pos.x), u32(pos.y));
  let global = pos_u + uniforms.position_origin;

  if (global.x >= uniforms.canvas_size.x || global.y >= uniforms.canvas_size.y) {
    return vec4<f32>(0.0);
  }

  let tile_origin_i = vec2<i32>(i32(uniforms.tile_origin.x), i32(uniforms.tile_origin.y));
  let global_i = vec2<i32>(i32(global.x), i32(global.y));
  let local_i = global_i - tile_origin_i;

  let tile_dims = textureDimensions(layer_tex);
  if (local_i.x < 0 || local_i.y < 0) {
    return vec4<f32>(0.0);
  }
  if (local_i.x >= i32(tile_dims.x) || local_i.y >= i32(tile_dims.y)) {
    return vec4<f32>(0.0);
  }

  let dst = textureLoad(layer_tex, local_i, 0);

  let scratch_dims = textureDimensions(scratch_tex);
  let scaled_x = min(u32(floor(f32(global.x) * uniforms.render_scale)), scratch_dims.x - 1u);
  let scaled_y = min(u32(floor(f32(global.y) * uniforms.render_scale)), scratch_dims.y - 1u);
  let src = textureLoad(scratch_tex, vec2<i32>(i32(scaled_x), i32(scaled_y)), 0);
  let selection_dims = textureDimensions(selection_tex);
  let sel_x = min(global.x, selection_dims.x - 1u);
  let sel_y = min(global.y, selection_dims.y - 1u);
  let mask = textureLoad(selection_tex, vec2<i32>(i32(sel_x), i32(sel_y)), 0).a;

  let src_alpha = clamp(src.a * uniforms.stroke_opacity * mask, 0.0, 1.0);
  if (src_alpha <= 0.0001) {
    return dst;
  }

  let dst_alpha = dst.a;
  let out_alpha = src_alpha + dst_alpha * (1.0 - src_alpha);

  var out_rgb: vec3<f32>;
  if (out_alpha > 0.0001) {
    out_rgb = (src.rgb * src_alpha + dst.rgb * dst_alpha * (1.0 - src_alpha)) / out_alpha;
  } else {
    out_rgb = vec3<f32>(0.0);
  }

  if (uniforms.apply_dither != 0u) {
    out_rgb = apply_dither(out_rgb, global.x, global.y, uniforms.dither_strength);
  }

  return vec4<f32>(out_rgb, out_alpha);
}

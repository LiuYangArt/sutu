struct Uniforms {
  canvas_size: vec2<u32>,
  tile_origin: vec2<u32>,
  fill_color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var dst_tex: texture_2d<f32>;
@group(0) @binding(2) var selection_tex: texture_2d<f32>;

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

@fragment
fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let local_xy = vec2<u32>(u32(pos.x), u32(pos.y));
  let global_xy = local_xy + uniforms.tile_origin;

  if (global_xy.x >= uniforms.canvas_size.x || global_xy.y >= uniforms.canvas_size.y) {
    return vec4<f32>(0.0);
  }

  let dst_dims = textureDimensions(dst_tex);
  if (local_xy.x >= dst_dims.x || local_xy.y >= dst_dims.y) {
    return vec4<f32>(0.0);
  }

  let dst = textureLoad(dst_tex, vec2<i32>(i32(local_xy.x), i32(local_xy.y)), 0);
  let selection_dims = textureDimensions(selection_tex);
  let sel_x = min(global_xy.x, selection_dims.x - 1u);
  let sel_y = min(global_xy.y, selection_dims.y - 1u);
  let mask = textureLoad(selection_tex, vec2<i32>(i32(sel_x), i32(sel_y)), 0).r;

  let src_alpha = clamp(uniforms.fill_color.a * mask, 0.0, 1.0);
  if (src_alpha <= 0.0001) {
    return dst;
  }

  let dst_alpha = dst.a;
  let out_alpha = src_alpha + dst_alpha * (1.0 - src_alpha);
  if (out_alpha <= 0.0001) {
    return vec4<f32>(0.0);
  }

  let out_rgb =
    (uniforms.fill_color.rgb * src_alpha * (1.0 - dst_alpha) + dst.rgb * dst_alpha) / out_alpha;
  return vec4<f32>(clamp(out_rgb, vec3<f32>(0.0), vec3<f32>(1.0)), out_alpha);
}

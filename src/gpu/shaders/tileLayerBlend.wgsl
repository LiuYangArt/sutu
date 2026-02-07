struct Uniforms {
  blend_mode: u32,
  layer_opacity: f32,
  _pad0: vec2<u32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var base_tex: texture_2d<f32>;
@group(0) @binding(2) var src_tex: texture_2d<f32>;

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

fn blend_rgb(mode: u32, dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
  switch mode {
    case 1u: {
      return dst * src;
    }
    case 2u: {
      return 1.0 - (1.0 - dst) * (1.0 - src);
    }
    case 3u: {
      let low = 2.0 * dst * src;
      let high = 1.0 - 2.0 * (1.0 - dst) * (1.0 - src);
      return select(low, high, dst >= vec3<f32>(0.5));
    }
    default: {
      return src;
    }
  }
}

@fragment
fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let local = vec2<i32>(i32(pos.x), i32(pos.y));
  let base_dims = textureDimensions(base_tex);
  if (local.x < 0 || local.y < 0 || local.x >= i32(base_dims.x) || local.y >= i32(base_dims.y)) {
    return vec4<f32>(0.0);
  }

  let dst = textureLoad(base_tex, local, 0);
  let src = textureLoad(src_tex, local, 0);

  let src_alpha = clamp(src.a * uniforms.layer_opacity, 0.0, 1.0);
  if (src_alpha <= 0.0001) {
    return dst;
  }

  let dst_alpha = dst.a;
  let out_alpha = src_alpha + dst_alpha * (1.0 - src_alpha);
  if (out_alpha <= 0.0001) {
    return vec4<f32>(0.0);
  }

  let blended_src = blend_rgb(uniforms.blend_mode, dst.rgb, src.rgb);
  // Porter-Duff source-over with blend mode:
  // out_premul = src*(1-dst_a) + dst*(1-src_a) + blend(dst,src)*dst_a*src_a
  let out_rgb =
    (src.rgb * src_alpha * (1.0 - dst_alpha) +
      dst.rgb * dst_alpha * (1.0 - src_alpha) +
      blended_src * dst_alpha * src_alpha) / out_alpha;
  return vec4<f32>(clamp(out_rgb, vec3<f32>(0.0), vec3<f32>(1.0)), out_alpha);
}

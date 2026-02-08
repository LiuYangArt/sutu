struct Uniforms {
  blend_mode: u32,
  layer_opacity: f32,
  transparent_backdrop_eps: f32,
  _pad0: u32,
  tile_origin: vec2<u32>,
  _pad1: vec2<u32>,
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

fn channel_color_dodge(dst: f32, src: f32) -> f32 {
  if (src >= 0.9999) {
    return 1.0;
  }
  return min(1.0, dst / max(0.0001, 1.0 - src));
}

fn channel_color_burn(dst: f32, src: f32) -> f32 {
  if (src <= 0.0001) {
    return 0.0;
  }
  return max(0.0, 1.0 - (1.0 - dst) / src);
}

fn channel_soft_light(dst: f32, src: f32) -> f32 {
  if (src <= 0.5) {
    return dst - (1.0 - 2.0 * src) * dst * (1.0 - dst);
  }
  let g = select(((16.0 * dst - 12.0) * dst + 4.0) * dst, sqrt(dst), dst > 0.25);
  return dst + (2.0 * src - 1.0) * (g - dst);
}

fn channel_linear_burn(dst: f32, src: f32) -> f32 {
  return clamp(dst + src - 1.0, 0.0, 1.0);
}

fn channel_linear_dodge(dst: f32, src: f32) -> f32 {
  return clamp(dst + src, 0.0, 1.0);
}

fn channel_vivid_light(dst: f32, src: f32) -> f32 {
  if (src <= 0.5) {
    return channel_color_burn(dst, 2.0 * src);
  }
  return channel_color_dodge(dst, 2.0 * (src - 0.5));
}

fn channel_linear_light(dst: f32, src: f32) -> f32 {
  return clamp(dst + 2.0 * src - 1.0, 0.0, 1.0);
}

fn channel_pin_light(dst: f32, src: f32) -> f32 {
  if (src <= 0.5) {
    return min(dst, 2.0 * src);
  }
  return max(dst, 2.0 * src - 1.0);
}

fn channel_hard_mix(dst: f32, src: f32) -> f32 {
  return select(0.0, 1.0, channel_vivid_light(dst, src) >= 0.5);
}

fn channel_divide(dst: f32, src: f32) -> f32 {
  if (src <= 0.0001) {
    return 1.0;
  }
  return clamp(dst / src, 0.0, 1.0);
}

fn hash_noise_01(x: u32, y: u32) -> f32 {
  let n = x * 1973u + y * 9277u + 89173u;
  let m = (n << 13u) ^ n;
  let t = m * (m * m * 15731u + 789221u) + 1376312589u;
  return f32(t & 0x00ffffffu) / 16777215.0;
}

fn rgb_to_hsl(color: vec3<f32>) -> vec3<f32> {
  let cmax = max(color.r, max(color.g, color.b));
  let cmin = min(color.r, min(color.g, color.b));
  let delta = cmax - cmin;
  let l = (cmax + cmin) * 0.5;
  var h = 0.0;
  var s = 0.0;

  if (delta > 0.0001) {
    s = delta / max(0.0001, 1.0 - abs(2.0 * l - 1.0));
    if (cmax == color.r) {
      h = (color.g - color.b) / delta;
      if (color.g < color.b) {
        h = h + 6.0;
      }
    } else if (cmax == color.g) {
      h = (color.b - color.r) / delta + 2.0;
    } else {
      h = (color.r - color.g) / delta + 4.0;
    }
    h = h / 6.0;
  }

  return vec3<f32>(h, s, l);
}

fn hue_to_rgb(p: f32, q: f32, t_value: f32) -> f32 {
  var t = t_value;
  if (t < 0.0) {
    t = t + 1.0;
  }
  if (t > 1.0) {
    t = t - 1.0;
  }
  if (t < 1.0 / 6.0) {
    return p + (q - p) * 6.0 * t;
  }
  if (t < 0.5) {
    return q;
  }
  if (t < 2.0 / 3.0) {
    return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  }
  return p;
}

fn hsl_to_rgb(hsl: vec3<f32>) -> vec3<f32> {
  let h = hsl.x;
  let s = hsl.y;
  let l = hsl.z;

  if (s <= 0.0001) {
    return vec3<f32>(l, l, l);
  }

  let q = select(l * (1.0 + s), l + s - l * s, l >= 0.5);
  let p = 2.0 * l - q;
  return vec3<f32>(
    hue_to_rgb(p, q, h + 1.0 / 3.0),
    hue_to_rgb(p, q, h),
    hue_to_rgb(p, q, h - 1.0 / 3.0)
  );
}

fn lum(color: vec3<f32>) -> f32 {
  return dot(color, vec3<f32>(0.3, 0.59, 0.11));
}

fn clip_color(color: vec3<f32>) -> vec3<f32> {
  var out = color;
  let l = lum(out);
  let n = min(out.r, min(out.g, out.b));
  let x = max(out.r, max(out.g, out.b));

  if (n < 0.0) {
    out = vec3<f32>(l) + ((out - vec3<f32>(l)) * l) / max(0.0001, l - n);
  }
  if (x > 1.0) {
    out = vec3<f32>(l) + ((out - vec3<f32>(l)) * (1.0 - l)) / max(0.0001, x - l);
  }

  return out;
}

fn set_lum(color: vec3<f32>, l: f32) -> vec3<f32> {
  let d = l - lum(color);
  return clip_color(color + vec3<f32>(d));
}

fn blend_rgb(mode: u32, dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
  switch mode {
    case 2u: {
      return min(dst, src);
    }
    case 3u: {
      return dst * src;
    }
    case 4u: {
      return vec3<f32>(
        channel_color_burn(dst.r, src.r),
        channel_color_burn(dst.g, src.g),
        channel_color_burn(dst.b, src.b)
      );
    }
    case 5u: {
      return vec3<f32>(
        channel_linear_burn(dst.r, src.r),
        channel_linear_burn(dst.g, src.g),
        channel_linear_burn(dst.b, src.b)
      );
    }
    case 6u: {
      let dst_sum = dst.r + dst.g + dst.b;
      let src_sum = src.r + src.g + src.b;
      if (src_sum < dst_sum) {
        return src;
      }
      return dst;
    }
    case 7u: {
      return max(dst, src);
    }
    case 8u: {
      return 1.0 - (1.0 - dst) * (1.0 - src);
    }
    case 9u: {
      return vec3<f32>(
        channel_color_dodge(dst.r, src.r),
        channel_color_dodge(dst.g, src.g),
        channel_color_dodge(dst.b, src.b)
      );
    }
    case 10u: {
      return vec3<f32>(
        channel_linear_dodge(dst.r, src.r),
        channel_linear_dodge(dst.g, src.g),
        channel_linear_dodge(dst.b, src.b)
      );
    }
    case 11u: {
      let dst_sum = dst.r + dst.g + dst.b;
      let src_sum = src.r + src.g + src.b;
      if (src_sum > dst_sum) {
        return src;
      }
      return dst;
    }
    case 12u: {
      let low = 2.0 * dst * src;
      let high = 1.0 - 2.0 * (1.0 - dst) * (1.0 - src);
      return select(low, high, dst >= vec3<f32>(0.5));
    }
    case 13u: {
      return vec3<f32>(
        channel_soft_light(dst.r, src.r),
        channel_soft_light(dst.g, src.g),
        channel_soft_light(dst.b, src.b)
      );
    }
    case 14u: {
      let low = 2.0 * dst * src;
      let high = 1.0 - 2.0 * (1.0 - dst) * (1.0 - src);
      return select(low, high, src >= vec3<f32>(0.5));
    }
    case 15u: {
      return vec3<f32>(
        channel_vivid_light(dst.r, src.r),
        channel_vivid_light(dst.g, src.g),
        channel_vivid_light(dst.b, src.b)
      );
    }
    case 16u: {
      return vec3<f32>(
        channel_linear_light(dst.r, src.r),
        channel_linear_light(dst.g, src.g),
        channel_linear_light(dst.b, src.b)
      );
    }
    case 17u: {
      return vec3<f32>(
        channel_pin_light(dst.r, src.r),
        channel_pin_light(dst.g, src.g),
        channel_pin_light(dst.b, src.b)
      );
    }
    case 18u: {
      return vec3<f32>(
        channel_hard_mix(dst.r, src.r),
        channel_hard_mix(dst.g, src.g),
        channel_hard_mix(dst.b, src.b)
      );
    }
    case 19u: {
      return abs(dst - src);
    }
    case 20u: {
      return dst + src - 2.0 * dst * src;
    }
    case 21u: {
      return max(vec3<f32>(0.0), dst - src);
    }
    case 22u: {
      return vec3<f32>(
        channel_divide(dst.r, src.r),
        channel_divide(dst.g, src.g),
        channel_divide(dst.b, src.b)
      );
    }
    case 23u: {
      let dst_hsl = rgb_to_hsl(dst);
      let src_hsl = rgb_to_hsl(src);
      return hsl_to_rgb(vec3<f32>(src_hsl.x, dst_hsl.y, dst_hsl.z));
    }
    case 24u: {
      let dst_hsl = rgb_to_hsl(dst);
      let src_hsl = rgb_to_hsl(src);
      return hsl_to_rgb(vec3<f32>(dst_hsl.x, src_hsl.y, dst_hsl.z));
    }
    case 25u: {
      return set_lum(src, lum(dst));
    }
    case 26u: {
      return set_lum(dst, lum(src));
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

  var src_alpha = clamp(src.a * uniforms.layer_opacity, 0.0, 1.0);
  if (uniforms.blend_mode == 1u) {
    let global_xy = uniforms.tile_origin + vec2<u32>(u32(local.x), u32(local.y));
    let noise = hash_noise_01(global_xy.x, global_xy.y);
    src_alpha = select(0.0, 1.0, noise < src_alpha);
  }
  if (src_alpha <= 0.0001) {
    return dst;
  }

  let dst_alpha = dst.a;
  let out_alpha = src_alpha + dst_alpha * (1.0 - src_alpha);
  if (out_alpha <= 0.0001) {
    return vec4<f32>(0.0);
  }

  var blended_src = src.rgb;
  if (uniforms.blend_mode > 1u && dst_alpha > uniforms.transparent_backdrop_eps) {
    blended_src = blend_rgb(uniforms.blend_mode, dst.rgb, src.rgb);
  }
  // Porter-Duff source-over with blend mode:
  // out_premul = src*(1-dst_a) + dst*(1-src_a) + blend(dst,src)*dst_a*src_a
  let out_rgb =
    (src.rgb * src_alpha * (1.0 - dst_alpha) +
      dst.rgb * dst_alpha * (1.0 - src_alpha) +
      blended_src * dst_alpha * src_alpha) / out_alpha;
  return vec4<f32>(clamp(out_rgb, vec3<f32>(0.0), vec3<f32>(1.0)), out_alpha);
}

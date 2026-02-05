struct Uniforms {
  size: vec2<u32>,
  apply_dither: u32,
  dither_strength: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

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

fn pattern_value(uv: vec2<f32>) -> f32 {
  var base: f32;
  if (uv.y < 0.3333) {
    base = uv.x;
  } else if (uv.y < 0.6666) {
    base = pow(uv.x, 2.2) * 0.15;
  } else {
    base = floor(uv.x * 64.0) / 63.0;
  }

  let center = vec2<f32>(0.5, 0.5);
  let radial = clamp(1.0 - length(uv - center) * 1.4, 0.0, 1.0);
  base = clamp(base + radial * 0.08, 0.0, 1.0);

  let layers = 6.0;
  return 1.0 - pow(1.0 - base, layers);
}

@fragment
fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let size = vec2<f32>(f32(uniforms.size.x), f32(uniforms.size.y));
  let uv = vec2<f32>(pos.x / size.x, pos.y / size.y);
  var color = vec3<f32>(pattern_value(uv));

  if (uniforms.apply_dither != 0u) {
    color = apply_dither(color, u32(pos.x), u32(pos.y), uniforms.dither_strength);
  }

  return vec4<f32>(color, 1.0);
}

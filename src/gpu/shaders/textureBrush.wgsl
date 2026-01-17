// ============================================================================
// Texture Brush Shader - WebGPU Render Pipeline for Texture-based Dab Rendering
// ============================================================================
//
// This shader implements texture-based brush rendering:
// - Uses imported brush textures (from ABR files) as brush tip
// - Supports rotation, scaling, and roundness transforms
// - Alpha Darken blending (same as parametric brush for consistency)
//
// IMPORTANT: This shader is ONLY for texture brushes. Parametric brushes
// (soft/hard with hardness control) use brush.wgsl - completely separate.
// ============================================================================

// ============================================================================
// Uniforms
// ============================================================================

struct Uniforms {
    canvas_size: vec2<f32>,
    color_blend_mode: f32,  // 0.0 = sRGB (8-bit quantize), 1.0 = linear
    _padding: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var stroke_source: texture_2d<f32>;  // Previous frame (read-only)
@group(0) @binding(2) var brush_texture: texture_2d<f32>;  // Brush tip texture
@group(0) @binding(3) var brush_sampler: sampler;          // Texture sampler

// ============================================================================
// Vertex Shader Types
// ============================================================================

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,           // UV for texture sampling (0-1)
    @location(1) color: vec3<f32>,         // RGB color
    @location(2) dab_opacity: f32,         // Alpha ceiling for Alpha Darken
    @location(3) flow: f32,                // Per-dab flow multiplier
};

// Instance data from vertex buffer (48 bytes per instance)
// Layout: x, y, size, roundness, angle, r, g, b, dabOpacity, flow, texWidth, texHeight
struct TextureDabInstance {
    @location(0) dab_pos: vec2<f32>,       // Dab center position (pixels)
    @location(1) dab_size: f32,            // Dab diameter (pixels)
    @location(2) roundness: f32,           // Brush roundness (0-1)
    @location(3) angle: f32,               // Rotation angle (radians)
    @location(4) color: vec3<f32>,         // RGB color (0-1)
    @location(5) dab_opacity: f32,         // Alpha ceiling (0-1)
    @location(6) flow: f32,                // Per-dab flow (0-1)
    @location(7) tex_size: vec2<f32>,      // Original texture size for aspect ratio
};

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(
    @builtin(vertex_index) vertex_idx: u32,
    @builtin(instance_index) instance_idx: u32,
    instance: TextureDabInstance
) -> VertexOutput {
    // Quad vertices (two triangles, counter-clockwise)
    // UV coordinates: (0,0) top-left to (1,1) bottom-right
    var quad_positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
    );
    var quad_uvs = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0)
    );

    let local_pos = quad_positions[vertex_idx];
    let uv = quad_uvs[vertex_idx];

    // Calculate quad size based on brush size and texture aspect ratio
    let tex_aspect = instance.tex_size.x / instance.tex_size.y;
    var half_width: f32;
    var half_height: f32;

    if (tex_aspect >= 1.0) {
        // Wider than tall
        half_width = instance.dab_size / 2.0;
        half_height = half_width / tex_aspect;
    } else {
        // Taller than wide
        half_height = instance.dab_size / 2.0;
        half_width = half_height * tex_aspect;
    }

    // Apply roundness (squeeze vertically)
    half_height = half_height * instance.roundness;

    // Apply rotation
    let cos_a = cos(instance.angle);
    let sin_a = sin(instance.angle);

    // Scale local position to actual size
    let scaled_pos = vec2<f32>(local_pos.x * half_width, local_pos.y * half_height);

    // Rotate around center
    let rotated_pos = vec2<f32>(
        scaled_pos.x * cos_a - scaled_pos.y * sin_a,
        scaled_pos.x * sin_a + scaled_pos.y * cos_a
    );

    // Translate to world position
    let world_pos = instance.dab_pos + rotated_pos;

    // Convert to clip space (-1 to 1), flip Y for screen coordinates
    let clip_pos = (world_pos / uniforms.canvas_size) * 2.0 - 1.0;

    var out: VertexOutput;
    out.position = vec4<f32>(clip_pos.x, -clip_pos.y, 0.0, 1.0);
    out.uv = uv;
    out.color = instance.color;
    out.dab_opacity = instance.dab_opacity;
    out.flow = instance.flow;
    return out;
}

// ============================================================================
// Color Space Conversion Functions
// ============================================================================

fn quantize_to_8bit(val: f32) -> f32 {
    return floor(val * 255.0 + 0.5) / 255.0;
}

// ============================================================================
// Fragment Shader - Texture Sampling with Alpha Darken Blending
// ============================================================================

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Sample brush texture
    // ABR textures are grayscale: R channel = mask value (0 = transparent, 1 = opaque)
    let tex_sample = textureSample(brush_texture, brush_sampler, in.uv);

    // Use R channel as mask (grayscale textures have equal R=G=B)
    let mask = tex_sample.r;

    // Skip nearly transparent pixels
    if (mask < 0.001) {
        discard;
    }

    // ========================================================================
    // Alpha Darken Blending
    // CRITICAL: Must match brush.wgsl and CPU maskCache.ts exactly!
    // srcAlpha = mask * flow (NOT mask * dabOpacity * flow)
    // dabOpacity is the ceiling for alpha accumulation
    // ========================================================================

    let src_alpha = mask * in.flow;
    let dab_opacity = in.dab_opacity;

    // Read from SOURCE texture (previous frame state)
    let pixel_coord = vec2<i32>(in.position.xy);
    let dst = textureLoad(stroke_source, pixel_coord, 0);
    let dst_a = dst.a;

    // Alpha Darken: lerp toward ceiling, stop when reached
    var out_a: f32;
    if (dst_a >= dab_opacity - 0.001) {
        out_a = dst_a;
    } else {
        out_a = dst_a + (dab_opacity - dst_a) * src_alpha;
    }

    // Color blending
    var out_rgb: vec3<f32>;
    if (dst_a > 0.001) {
        out_rgb = dst.rgb + (in.color - dst.rgb) * src_alpha;
    } else {
        out_rgb = in.color;
    }

    // ========================================================================
    // Color Space Post-Processing
    // ========================================================================
    if (uniforms.color_blend_mode < 0.5) {
        // sRGB mode: quantize to 8-bit
        out_rgb = vec3(
            quantize_to_8bit(out_rgb.r),
            quantize_to_8bit(out_rgb.g),
            quantize_to_8bit(out_rgb.b)
        );
        out_a = quantize_to_8bit(out_a);
    }

    return vec4<f32>(out_rgb, out_a);
}

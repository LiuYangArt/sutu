// ============================================================================
// Brush Shader - WebGPU Render Pipeline for Dab Rendering
// ============================================================================
//
// This shader implements:
// - GPU Instancing for batched dab rendering
// - Alpha Darken blending (custom, not hardware blend)
// - Soft brush edge using Gaussian (erf-based) falloff
// - Hard brush with 1px anti-aliased edge
//
// CRITICAL: The Alpha Darken logic MUST match maskCache.ts blendPixel() exactly
// to ensure WYSIWYG (preview matches composite result).
// ============================================================================

// ============================================================================
// Uniforms
// ============================================================================

struct Uniforms {
    canvas_size: vec2<f32>,
    _padding: vec2<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var stroke_source: texture_2d<f32>;  // Previous frame (read-only)

// ============================================================================
// Vertex Shader Types
// ============================================================================

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) local_uv: vec2<f32>,      // UV within quad (range depends on extent)
    @location(1) color: vec3<f32>,          // RGB color
    @location(2) hardness: f32,
    @location(3) dab_opacity: f32,          // Alpha ceiling for Alpha Darken
    @location(4) flow: f32,                 // Per-dab flow multiplier
    @location(5) dab_size: f32,             // Dab radius in pixels (for AA calculation)
    @location(6) extent_multiplier: f32,    // Quad expansion factor for soft brushes
};

// Instance data from vertex buffer (matches InstanceBuffer layout, 36 bytes)
struct DabInstance {
    @location(0) dab_pos: vec2<f32>,       // Dab center position (pixels)
    @location(1) dab_size: f32,            // Dab radius (pixels)
    @location(2) hardness: f32,            // Edge hardness (0-1)
    @location(3) color: vec3<f32>,         // RGB color (0-1)
    @location(4) dab_opacity: f32,         // Alpha ceiling (0-1)
    @location(5) flow: f32,                // Per-dab flow (0-1)
};

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(
    @builtin(vertex_index) vertex_idx: u32,
    @builtin(instance_index) instance_idx: u32,
    instance: DabInstance
) -> VertexOutput {
    // Quad vertices (two triangles, counter-clockwise)
    var quad_positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
    );

    // Calculate extent multiplier based on hardness (matches CPU maskCache.ts)
    // For soft brushes, the Gaussian falloff extends beyond dab_size
    // fade = (1 - hardness) * 2, extentMultiplier = 1 + fade
    let fade = (1.0 - instance.hardness) * 2.0;
    let extent_multiplier = select(1.0, 1.0 + fade, instance.hardness < 0.99);
    let effective_radius = instance.dab_size * extent_multiplier;

    let local_pos = quad_positions[vertex_idx];
    let world_pos = instance.dab_pos + local_pos * effective_radius;

    // Convert to clip space (-1 to 1), flip Y for screen coordinates
    let clip_pos = (world_pos / uniforms.canvas_size) * 2.0 - 1.0;

    var out: VertexOutput;
    out.position = vec4<f32>(clip_pos.x, -clip_pos.y, 0.0, 1.0);
    // local_pos is [-1, 1] within expanded quad; will be scaled by extent_multiplier in fragment shader
    out.local_uv = local_pos;
    out.color = instance.color;
    out.hardness = instance.hardness;
    out.dab_opacity = instance.dab_opacity;
    out.flow = instance.flow;
    out.dab_size = instance.dab_size;
    out.extent_multiplier = extent_multiplier;
    return out;
}

// ============================================================================
// Error Function Approximation (for Gaussian soft edge)
// ============================================================================

// Abramowitz and Stegun approximation (matches maskCache.ts erfFast)
fn erf_approx(x: f32) -> f32 {
    let sign_x = sign(x);
    let ax = abs(x);

    if (ax >= 4.0) {
        return sign_x;
    }

    let p = 0.3275911;
    let a1 = 0.254829592;
    let a2 = -0.284496736;
    let a3 = 1.421413741;
    let a4 = -1.453152027;
    let a5 = 1.061405429;

    let t = 1.0 / (1.0 + p * ax);
    let y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * exp(-ax * ax);

    return sign_x * y;
}

// ============================================================================
// Fragment Shader - Alpha Darken Blending
// ============================================================================

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // local_uv is [-1, 1] within the expanded quad
    // Multiply by extent_multiplier to get distance relative to original dab boundary
    // dist = 1.0 corresponds to the original dab edge (not expanded edge)
    let dist = length(in.local_uv) * in.extent_multiplier;

    // Discard pixels outside the expanded extent
    if (dist > in.extent_multiplier) {
        discard;
    }

    // ========================================================================
    // Calculate mask shape based on hardness
    // ========================================================================
    var mask: f32;

    if (in.hardness >= 0.99) {
        // Hard brush: sharp edge with 1px anti-aliasing
        // Use physical pixel size for AA band calculation
        // in.dab_size is the radius in pixels
        let pixel_size = 1.0 / in.dab_size;  // 1 pixel in normalized units
        let half_pixel = pixel_size * 0.5;

        let edge_dist = dist - 1.0;  // Distance from edge in normalized units

        if (edge_dist >= half_pixel) {
            // Fully outside
            mask = 0.0;
        } else if (edge_dist > -half_pixel) {
            // Within 1px AA band: linear falloff
            mask = (half_pixel - edge_dist) / pixel_size;
        } else {
            // Fully inside
            mask = 1.0;
        }
    } else {
        // Soft brush: Gaussian (erf-based) falloff
        // Matches maskCache.ts generateMask with maskType='gaussian'
        //
        // CPU uses: distfactor = (SQRT_2 * 12500.0) / (6761.0 * safeFade * radiusX)
        //           scaledDist = physicalDist * distfactor
        // where physicalDist = normDist * radiusX
        //
        // So: scaledDist = normDist * radiusX * (SQRT_2 * 12500.0) / (6761.0 * safeFade * radiusX)
        //                = normDist * (SQRT_2 * 12500.0) / (6761.0 * safeFade)
        //
        // But we use `dist` which is already normalized (0-1), and in.dab_size is radius.
        // We need: physicalDist = dist * in.dab_size
        //          distfactor = (SQRT_2 * 12500.0) / (6761.0 * safeFade * in.dab_size)
        //          scaledDist = physicalDist * distfactor

        let fade = (1.0 - in.hardness) * 2.0;
        let safe_fade = max(0.001, fade);

        let SQRT_2 = 1.41421356;
        let center = (2.5 * (6761.0 * safe_fade - 10000.0)) / (SQRT_2 * 6761.0 * safe_fade);
        let alphafactor = 1.0 / (2.0 * erf_approx(center));

        // Calculate distance factor for Gaussian falloff
        // Corresponds to CPU: distScale = (Math.SQRT2 * 12500) / (6761 * safeFade * diameter)
        let distfactor = (SQRT_2 * 12500.0) / (6761.0 * safe_fade * in.dab_size);

        // Convert normalized dist to physical distance, then scale
        let physical_dist = dist * in.dab_size;
        let scaled_dist = physical_dist * distfactor;
        let val = alphafactor * (erf_approx(scaled_dist + center) - erf_approx(scaled_dist - center));
        mask = saturate(val);
    }

    // Skip nearly transparent pixels
    if (mask < 0.001) {
        discard;
    }

    // ========================================================================
    // Alpha Darken Blending
    // CRITICAL: Must match maskCache.ts blendPixel() exactly!
    // srcAlpha = mask * flow (NOT mask * dabOpacity * flow)
    // dabOpacity is the ceiling for alpha accumulation
    // ========================================================================

    let src_alpha = mask * in.flow;  // Corrected: mask * flow only
    let dab_opacity = in.dab_opacity;  // Separate ceiling value

    // Read from SOURCE texture (previous frame state)
    let pixel_coord = vec2<i32>(in.position.xy);
    let dst = textureLoad(stroke_source, pixel_coord, 0);
    let dst_a = dst.a;

    // Alpha Darken: lerp toward ceiling, stop when reached
    // This matches: dstA >= dabOpacity - 0.001 ? dstA : dstA + (dabOpacity - dstA) * srcAlpha
    var out_a: f32;
    if (dst_a >= dab_opacity - 0.001) {
        // Already at ceiling, no change
        out_a = dst_a;
    } else {
        // Lerp from current alpha toward ceiling
        out_a = dst_a + (dab_opacity - dst_a) * src_alpha;
    }

    // Color blending
    var out_rgb: vec3<f32>;
    if (dst_a > 0.001) {
        // Existing color: blend toward new color
        out_rgb = dst.rgb + (in.color - dst.rgb) * src_alpha;
    } else {
        // No existing color: use source directly
        out_rgb = in.color;
    }

    return vec4<f32>(out_rgb, out_a);
}

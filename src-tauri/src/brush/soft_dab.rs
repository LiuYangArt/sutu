//! Soft Brush Dab Renderer - SIMD optimized Gaussian mask rendering
//!
//! This module implements Krita-style soft brush rendering with:
//! - SIMD vectorized erf calculation (AVX: 8 pixels at once)
//! - Per-row batch processing (FastRowProcessor pattern)
//! - Alpha Darken compositing
//!
//! Reference: Krita's kis_brush_mask_processor_factories.cpp

use std::f32::consts::SQRT_2;

/// Gaussian mask parameters (pre-calculated for performance)
///
/// These parameters are computed once when brush settings change,
/// avoiding redundant calculations per-pixel.
#[derive(Clone, Debug)]
pub struct GaussParams {
    pub center: f32,
    pub alphafactor: f32,
    pub distfactor: f32,
    pub ycoef: f32,
    pub fade: f32,
}

impl GaussParams {
    /// Create new Gaussian parameters from brush settings
    ///
    /// # Arguments
    /// * `hardness` - Brush hardness (0.0 = soft, 1.0 = hard)
    /// * `radius` - Brush radius in pixels
    /// * `roundness` - Brush roundness (1.0 = circle, <1.0 = ellipse)
    pub fn new(hardness: f32, radius: f32, roundness: f32) -> Self {
        // Enhanced fade for softer edges (matching frontend logic)
        let fade = (1.0 - hardness) * 2.0;
        let safe_fade = fade.clamp(1e-6, 2.0);

        // Krita-style Gaussian parameters
        let center = (2.5 * (6761.0 * safe_fade - 10000.0)) / (SQRT_2 * 6761.0 * safe_fade);
        let alphafactor = 255.0 / (2.0 * erf_scalar(center));
        let distfactor = SQRT_2 * 12500.0 / (6761.0 * safe_fade * radius.max(0.5));

        Self {
            center,
            alphafactor,
            distfactor,
            ycoef: 1.0 / roundness.max(0.01),
            fade: safe_fade,
        }
    }
}

/// Scalar erf function (Abramowitz and Stegun formula 7.1.26)
/// Accuracy: |error| < 1.5e-7
#[inline]
pub fn erf_scalar(x: f32) -> f32 {
    let sign = if x >= 0.0 { 1.0 } else { -1.0 };
    let x = x.abs();

    const A1: f32 = 0.254_829_6;
    const A2: f32 = -0.284_496_72;
    const A3: f32 = 1.421_413_8;
    const A4: f32 = -1.453_152_1;
    const A5: f32 = 1.061_405_4;
    const P: f32 = 0.327_591_1;

    let t = 1.0 / (1.0 + P * x);
    let y = 1.0 - (((((A5 * t + A4) * t) + A3) * t + A2) * t + A1) * t * (-x * x).exp();

    sign * y
}

/// Calculate mask shape for a single pixel (scalar fallback)
#[inline]
fn calculate_mask_scalar(dist: f32, params: &GaussParams) -> f32 {
    let val_dist = dist * params.distfactor;
    let full_fade = params.alphafactor
        * (erf_scalar(val_dist + params.center) - erf_scalar(val_dist - params.center));
    ((255.0 - full_fade) / 255.0).clamp(0.0, 1.0)
}

/// Process a row of pixels using scalar operations (fallback)
fn process_row_scalar(
    buffer: &mut [f32],
    width: usize,
    row_y: f32,
    center_x: f32,
    center_y: f32,
    params: &GaussParams,
) {
    let y_ = row_y - center_y;
    let y_scaled = y_ * params.ycoef;
    let y2 = y_scaled * y_scaled;

    for (col, mask_val) in buffer.iter_mut().enumerate().take(width) {
        let x = col as f32 + 0.5 - center_x;
        let dist = (x * x + y2).sqrt();
        *mask_val = calculate_mask_scalar(dist, params);
    }
}

// ============================================================================
// SIMD Implementations
// ============================================================================

#[cfg(target_arch = "x86_64")]
mod simd {
    use super::*;
    use std::arch::x86_64::*;

    /// Fast exp approximation using AVX (Schraudolph's method)
    /// Accuracy: ~1% relative error, sufficient for brush masks
    #[inline]
    #[target_feature(enable = "avx")]
    unsafe fn exp_avx_fast(x: __m256) -> __m256 {
        // Clamp input to prevent overflow
        let x = _mm256_max_ps(_mm256_set1_ps(-87.0), x);
        let x = _mm256_min_ps(_mm256_set1_ps(88.0), x);

        // Constants for exp approximation
        let log2e = _mm256_set1_ps(std::f32::consts::LOG2_E);
        let c1 = _mm256_set1_ps(12102203.0); // (1 << 23) / ln(2)
        let c2 = _mm256_set1_ps(1065353216.0); // (127 << 23)

        // exp(x) = 2^(x * log2(e))
        let t = _mm256_mul_ps(x, log2e);
        let t = _mm256_add_ps(_mm256_mul_ps(t, c1), c2);

        // Reinterpret as float (fast 2^x approximation)
        _mm256_castsi256_ps(_mm256_cvtps_epi32(t))
    }

    /// SIMD erf function - processes 8 floats at once
    /// Based on Krita's VcExtraMath::erf (vc_extra_math.h)
    #[inline]
    #[target_feature(enable = "avx")]
    pub unsafe fn erf_avx(x: __m256) -> __m256 {
        // Extract sign
        let sign_mask = _mm256_set1_ps(-0.0);
        let sign = _mm256_and_ps(x, sign_mask);
        let xa = _mm256_andnot_ps(sign_mask, x); // abs(x)

        // Clamp to valid range (beyond 4.0, erf ≈ 1.0)
        let limit = _mm256_set1_ps(4.0);
        let limit_mask = _mm256_cmp_ps(xa, limit, _CMP_GE_OQ);
        let xa = _mm256_blendv_ps(xa, _mm256_setzero_ps(), limit_mask);

        // Abramowitz and Stegun coefficients
        let a1 = _mm256_set1_ps(0.254_829_6);
        let a2 = _mm256_set1_ps(-0.284_496_72);
        let a3 = _mm256_set1_ps(1.421_413_8);
        let a4 = _mm256_set1_ps(-1.453_152_1);
        let a5 = _mm256_set1_ps(1.061_405_4);
        let p = _mm256_set1_ps(0.327_591_1);
        let one = _mm256_set1_ps(1.0);

        // t = 1 / (1 + p * |x|)
        let t = _mm256_div_ps(one, _mm256_add_ps(one, _mm256_mul_ps(p, xa)));

        // Horner's method: poly = ((((a5*t + a4)*t + a3)*t + a2)*t + a1)*t
        let mut poly = _mm256_mul_ps(a5, t);
        poly = _mm256_add_ps(poly, a4);
        poly = _mm256_mul_ps(poly, t);
        poly = _mm256_add_ps(poly, a3);
        poly = _mm256_mul_ps(poly, t);
        poly = _mm256_add_ps(poly, a2);
        poly = _mm256_mul_ps(poly, t);
        poly = _mm256_add_ps(poly, a1);
        poly = _mm256_mul_ps(poly, t);

        // exp(-x²)
        let neg_x2 = _mm256_mul_ps(_mm256_set1_ps(-1.0), _mm256_mul_ps(xa, xa));
        let exp_val = exp_avx_fast(neg_x2);

        // y = 1 - poly * exp(-x²)
        let y = _mm256_sub_ps(one, _mm256_mul_ps(poly, exp_val));

        // Handle limit case (|x| >= 4.0 -> return 1.0)
        let y = _mm256_blendv_ps(y, one, limit_mask);

        // Restore sign
        _mm256_or_ps(y, sign)
    }

    /// Process a row of pixels using AVX SIMD
    #[target_feature(enable = "avx")]
    pub unsafe fn process_row_avx(
        buffer: &mut [f32],
        width: usize,
        row_y: f32,
        center_x: f32,
        center_y: f32,
        params: &GaussParams,
    ) {
        let y_ = row_y - center_y;
        let y_scaled = y_ * params.ycoef;
        let y2 = y_scaled * y_scaled;

        let chunks = width / 8;

        let v_center = _mm256_set1_ps(params.center);
        let v_alphafactor = _mm256_set1_ps(params.alphafactor);
        let v_distfactor = _mm256_set1_ps(params.distfactor);
        let v_y2 = _mm256_set1_ps(y2);
        let v_255 = _mm256_set1_ps(255.0);
        let v_one = _mm256_set1_ps(1.0);
        let v_zero = _mm256_setzero_ps();

        // Process 8 pixels at a time
        for chunk in 0..chunks {
            let base_x = chunk * 8;

            // Create x offsets: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5] + base_x - center_x
            let offset = base_x as f32 - center_x;
            let x_indices = _mm256_add_ps(
                _mm256_set1_ps(offset),
                _mm256_set_ps(7.5, 6.5, 5.5, 4.5, 3.5, 2.5, 1.5, 0.5),
            );

            // dist = sqrt(x² + y²)
            let x2 = _mm256_mul_ps(x_indices, x_indices);
            let dist2 = _mm256_add_ps(x2, v_y2);
            let dist = _mm256_sqrt_ps(dist2);

            // val_dist = dist * distfactor
            let val_dist = _mm256_mul_ps(dist, v_distfactor);

            // fullFade = alphafactor * (erf(val_dist + center) - erf(val_dist - center))
            let erf_plus = erf_avx(_mm256_add_ps(val_dist, v_center));
            let erf_minus = erf_avx(_mm256_sub_ps(val_dist, v_center));
            let full_fade = _mm256_mul_ps(v_alphafactor, _mm256_sub_ps(erf_plus, erf_minus));

            // mask = (255 - fullFade) / 255, clamped to [0, 1]
            let mask = _mm256_div_ps(_mm256_sub_ps(v_255, full_fade), v_255);
            let mask = _mm256_max_ps(v_zero, _mm256_min_ps(v_one, mask));

            // Store result
            _mm256_storeu_ps(buffer.as_mut_ptr().add(base_x), mask);
        }

        // Handle remaining pixels (scalar)
        let start = chunks * 8;
        for (col, mask_val) in buffer
            .iter_mut()
            .enumerate()
            .skip(start)
            .take(width - start)
        {
            let x = col as f32 + 0.5 - center_x;
            let dist = (x * x + y2).sqrt();
            *mask_val = calculate_mask_scalar(dist, params);
        }
    }
}

/// Process a row of pixels (auto-selects SIMD or scalar)
pub fn process_row(
    buffer: &mut [f32],
    width: usize,
    row_y: f32,
    center_x: f32,
    center_y: f32,
    params: &GaussParams,
) {
    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx") {
            // SAFETY: We've verified AVX is available
            unsafe {
                simd::process_row_avx(buffer, width, row_y, center_x, center_y, params);
            }
            return;
        }
    }

    // Fallback to scalar
    process_row_scalar(buffer, width, row_y, center_x, center_y, params);
}

/// Render a complete soft brush dab with Alpha Darken compositing
///
/// # Arguments
/// * `buffer` - RGBA buffer (straight alpha, u8)
/// * `buffer_width`, `buffer_height` - Buffer dimensions
/// * `cx`, `cy` - Dab center coordinates
/// * `radius` - Dab radius in pixels
/// * `params` - Pre-calculated Gaussian parameters
/// * `color` - RGB color (0-255)
/// * `flow` - Per-dab accumulation rate (0.0-1.0)
/// * `dab_opacity` - Target alpha ceiling (0.0-1.0)
///
/// # Returns
/// Dirty rectangle (left, top, width, height)
#[allow(clippy::too_many_arguments)]
pub fn render_soft_dab(
    buffer: &mut [u8],
    buffer_width: usize,
    buffer_height: usize,
    cx: f32,
    cy: f32,
    radius: f32,
    params: &GaussParams,
    color: (u8, u8, u8),
    flow: f32,
    dab_opacity: f32,
) -> (usize, usize, usize, usize) {
    // Calculate extent based on fade (soft brushes need larger area)
    let extent_mult = 1.0 + params.fade;
    let extent = (radius * extent_mult + 1.0).ceil() as i32;

    let left = ((cx - extent as f32) as i32).max(0) as usize;
    let top = ((cy - extent as f32) as i32).max(0) as usize;
    let right = ((cx + extent as f32) as i32 + 1).min(buffer_width as i32) as usize;
    let bottom = ((cy + extent as f32) as i32 + 1).min(buffer_height as i32) as usize;

    let width = right.saturating_sub(left);
    let height = bottom.saturating_sub(top);

    if width == 0 || height == 0 {
        return (0, 0, 0, 0);
    }

    // Temporary mask buffer for one row
    let mut mask_row = vec![0.0f32; width];

    let (r, g, b) = (color.0 as f32, color.1 as f32, color.2 as f32);

    for row in 0..height {
        let world_y = (top + row) as f32 + 0.5;

        // Calculate mask values for this row
        process_row(&mut mask_row, width, world_y, cx - left as f32, cy, params);

        for (col, &mask_shape) in mask_row.iter().enumerate().take(width) {
            if mask_shape < 0.001 {
                continue;
            }

            let src_alpha = mask_shape * flow;
            let target_alpha = dab_opacity;

            let idx = ((top + row) * buffer_width + left + col) * 4;
            if idx + 3 >= buffer.len() {
                continue;
            }

            let dst_r = buffer[idx] as f32;
            let dst_g = buffer[idx + 1] as f32;
            let dst_b = buffer[idx + 2] as f32;
            let dst_a = buffer[idx + 3] as f32 / 255.0;

            // Alpha Darken compositing (Krita-style)
            // - If dst_a >= target: no change
            // - Otherwise: lerp toward target
            let out_a = if dst_a >= target_alpha - 0.001 {
                dst_a
            } else {
                dst_a + (target_alpha - dst_a) * src_alpha
            };

            if out_a > 0.001 {
                let has_existing = dst_a > 0.001;
                let out_r = if has_existing {
                    dst_r + (r - dst_r) * src_alpha
                } else {
                    r
                };
                let out_g = if has_existing {
                    dst_g + (g - dst_g) * src_alpha
                } else {
                    g
                };
                let out_b = if has_existing {
                    dst_b + (b - dst_b) * src_alpha
                } else {
                    b
                };

                buffer[idx] = out_r.round().clamp(0.0, 255.0) as u8;
                buffer[idx + 1] = out_g.round().clamp(0.0, 255.0) as u8;
                buffer[idx + 2] = out_b.round().clamp(0.0, 255.0) as u8;
                buffer[idx + 3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
    }

    (left, top, width, height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_erf_scalar() {
        // erf(0) = 0
        assert!((erf_scalar(0.0)).abs() < 0.001);
        // erf(1) ≈ 0.8427
        assert!((erf_scalar(1.0) - 0.8427).abs() < 0.01);
        // erf(-1) ≈ -0.8427
        assert!((erf_scalar(-1.0) + 0.8427).abs() < 0.01);
        // erf(3) ≈ 0.9999
        assert!((erf_scalar(3.0) - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_gauss_params() {
        let params = GaussParams::new(0.0, 100.0, 1.0);
        assert!(params.center < 0.0); // Soft brush has negative center
        assert!(params.alphafactor > 0.0);
        assert!(params.distfactor > 0.0);

        let hard_params = GaussParams::new(1.0, 100.0, 1.0);
        // Hard brush should have very small fade
        assert!(hard_params.fade < 0.01);
    }

    #[test]
    fn test_process_row() {
        let params = GaussParams::new(0.5, 50.0, 1.0);
        let mut buffer = vec![0.0f32; 100];

        process_row(&mut buffer, 100, 50.0, 50.0, 50.0, &params);

        // Center should have high mask value
        assert!(buffer[50] > 0.5);
        // Edges should have lower values
        assert!(buffer[0] < buffer[50]);
        assert!(buffer[99] < buffer[50]);
    }

    #[test]
    fn test_render_soft_dab() {
        let mut buffer = vec![0u8; 200 * 200 * 4];
        let params = GaussParams::new(0.5, 20.0, 1.0);

        let (left, top, width, height) = render_soft_dab(
            &mut buffer,
            200,
            200,
            100.0,
            100.0,
            20.0,
            &params,
            (255, 0, 0),
            1.0,
            1.0,
        );

        // Should have valid dirty rect
        assert!(width > 0);
        assert!(height > 0);

        // Center pixel should be red with high alpha
        let center_idx = (100 * 200 + 100) * 4;
        assert!(buffer[center_idx] > 200); // R
        assert!(buffer[center_idx + 3] > 200); // A
    }
}

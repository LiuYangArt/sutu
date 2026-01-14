//! Brush engine module - handles stroke processing and brush rendering
//!
//! ## Architecture: Flow/Opacity Three-Level Pipeline
//!
//! The brush system uses a three-level rendering pipeline to achieve
//! Photoshop-like behavior:
//!
//! 1. **Dab Level** (stamper.rs): Individual brush stamps with Flow-controlled alpha
//! 2. **Stroke Buffer** (stroke_buffer.rs): Accumulates dabs within a single stroke
//! 3. **Layer Level**: Composites stroke with Opacity as ceiling
//!
//! This separation allows Flow to accumulate within a stroke while Opacity
//! acts as a maximum limit.

mod blend;
mod engine;
mod interpolation;
pub mod soft_dab;
mod stamper;
mod stroke_buffer;

pub use blend::{blend_normal_premul, BlendFunc};
pub use engine::{BrushEngine, BrushSettings};
pub use interpolation::{interpolate_catmull_rom, InterpolationMode};
pub use stamper::{BrushStamper, Dab, StamperConfig};
pub use stroke_buffer::{Pixel, Rect, StrokeBuffer};

use serde::{Deserialize, Serialize};

/// A single point in a processed brush stroke
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct BrushPoint {
    /// X coordinate
    pub x: f32,
    /// Y coordinate
    pub y: f32,
    /// Brush size at this point (after pressure curve)
    pub size: f32,
    /// Opacity at this point (after pressure curve)
    pub opacity: f32,
    /// Rotation angle in radians
    pub rotation: f32,
}

/// A segment of a stroke ready for rendering
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrokeSegment {
    /// Processed brush points
    pub points: Vec<BrushPoint>,
    /// Brush identifier
    pub brush_id: u32,
    /// RGBA color
    pub color: [f32; 4],
    /// Blend mode for this segment
    pub blend_mode: BlendMode,
}

/// Blend modes for stroke rendering
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum BlendMode {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
}

/// Pressure curve types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PressureCurve {
    /// Linear mapping (1:1)
    #[default]
    Linear,
    /// Soft curve (more sensitive at low pressure)
    Soft,
    /// Hard curve (less sensitive at low pressure)
    Hard,
    /// Custom curve (uses control points)
    Custom,
}

impl PressureCurve {
    /// Apply the pressure curve to a raw pressure value
    pub fn apply(&self, pressure: f32) -> f32 {
        let p = pressure.clamp(0.0, 1.0);

        match self {
            PressureCurve::Linear => p,
            PressureCurve::Soft => {
                // Ease-out: more sensitive at low pressure
                1.0 - (1.0 - p).powi(2)
            }
            PressureCurve::Hard => {
                // Ease-in: less sensitive at low pressure
                p.powi(2)
            }
            PressureCurve::Custom => {
                // TODO: Implement custom curve with control points
                p
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pressure_curve_linear() {
        let curve = PressureCurve::Linear;
        assert_eq!(curve.apply(0.0), 0.0);
        assert_eq!(curve.apply(0.5), 0.5);
        assert_eq!(curve.apply(1.0), 1.0);
    }

    #[test]
    fn test_pressure_curve_soft() {
        let curve = PressureCurve::Soft;
        assert_eq!(curve.apply(0.0), 0.0);
        assert_eq!(curve.apply(1.0), 1.0);
        // Soft curve should give higher output for mid pressure
        assert!(curve.apply(0.5) > 0.5);
    }

    #[test]
    fn test_pressure_curve_hard() {
        let curve = PressureCurve::Hard;
        assert_eq!(curve.apply(0.0), 0.0);
        assert_eq!(curve.apply(1.0), 1.0);
        // Hard curve should give lower output for mid pressure
        assert!(curve.apply(0.5) < 0.5);
    }

    #[test]
    fn test_pressure_clamping() {
        let curve = PressureCurve::Linear;
        assert_eq!(curve.apply(-0.5), 0.0);
        assert_eq!(curve.apply(1.5), 1.0);
    }
}

//! Brush engine - processes raw input into renderable brush strokes

use super::{BlendMode, BrushPoint, PressureCurve, StrokeSegment};
use super::interpolation::{interpolate_catmull_rom, InterpolationMode};
use crate::input::RawInputPoint;

/// Brush settings
#[derive(Debug, Clone)]
pub struct BrushSettings {
    /// Base brush size in pixels
    pub size: f32,
    /// Base opacity (0.0 - 1.0)
    pub opacity: f32,
    /// Hardness (0.0 - 1.0), affects edge falloff
    pub hardness: f32,
    /// Spacing between brush stamps (as fraction of size)
    pub spacing: f32,
    /// Pressure affects size
    pub pressure_size: bool,
    /// Pressure affects opacity
    pub pressure_opacity: bool,
    /// Pressure curve for size
    pub size_curve: PressureCurve,
    /// Pressure curve for opacity
    pub opacity_curve: PressureCurve,
    /// Interpolation mode
    pub interpolation: InterpolationMode,
}

impl Default for BrushSettings {
    fn default() -> Self {
        Self {
            size: 20.0,
            opacity: 1.0,
            hardness: 1.0,
            spacing: 0.25,
            pressure_size: true,
            pressure_opacity: true,
            size_curve: PressureCurve::Linear,
            opacity_curve: PressureCurve::Linear,
            interpolation: InterpolationMode::CatmullRom,
        }
    }
}

/// The main brush engine that processes strokes
pub struct BrushEngine {
    settings: BrushSettings,
    current_brush_id: u32,
    current_color: [f32; 4],
    current_blend_mode: BlendMode,
}

impl BrushEngine {
    /// Create a new brush engine with default settings
    pub fn new() -> Self {
        Self {
            settings: BrushSettings::default(),
            current_brush_id: 0,
            current_color: [0.0, 0.0, 0.0, 1.0], // Black
            current_blend_mode: BlendMode::Normal,
        }
    }

    /// Create with custom settings
    pub fn with_settings(settings: BrushSettings) -> Self {
        Self {
            settings,
            ..Self::new()
        }
    }

    /// Update brush settings
    pub fn set_settings(&mut self, settings: BrushSettings) {
        self.settings = settings;
    }

    /// Set brush color (RGBA, 0.0-1.0)
    pub fn set_color(&mut self, color: [f32; 4]) {
        self.current_color = color;
    }

    /// Set blend mode
    pub fn set_blend_mode(&mut self, mode: BlendMode) {
        self.current_blend_mode = mode;
    }

    /// Process raw input points into renderable stroke segments
    pub fn process(&self, points: &[RawInputPoint]) -> Vec<StrokeSegment> {
        if points.len() < 2 {
            return vec![];
        }

        // Interpolate points for smoother strokes
        let interpolated = self.interpolate_points(points);

        // Convert to brush points with pressure curves applied
        let brush_points: Vec<BrushPoint> = interpolated
            .iter()
            .map(|p| self.raw_to_brush_point(p))
            .collect();

        // Create stroke segment
        vec![StrokeSegment {
            points: brush_points,
            brush_id: self.current_brush_id,
            color: self.current_color,
            blend_mode: self.current_blend_mode,
        }]
    }

    /// Interpolate raw points based on settings
    fn interpolate_points(&self, points: &[RawInputPoint]) -> Vec<RawInputPoint> {
        match self.settings.interpolation {
            InterpolationMode::None => points.to_vec(),
            InterpolationMode::Linear => self.interpolate_linear(points),
            InterpolationMode::CatmullRom => self.interpolate_catmull_rom(points),
        }
    }

    /// Linear interpolation between points
    fn interpolate_linear(&self, points: &[RawInputPoint]) -> Vec<RawInputPoint> {
        if points.len() < 2 {
            return points.to_vec();
        }

        let mut result = Vec::with_capacity(points.len() * 4);
        let spacing = self.settings.size * self.settings.spacing;

        for i in 0..points.len() - 1 {
            let p0 = &points[i];
            let p1 = &points[i + 1];

            let dx = p1.x - p0.x;
            let dy = p1.y - p0.y;
            let dist = (dx * dx + dy * dy).sqrt();

            if dist < spacing {
                result.push(*p0);
                continue;
            }

            let steps = (dist / spacing).ceil() as usize;
            for step in 0..steps {
                let t = step as f32 / steps as f32;
                result.push(RawInputPoint {
                    x: p0.x + dx * t,
                    y: p0.y + dy * t,
                    pressure: p0.pressure + (p1.pressure - p0.pressure) * t,
                    tilt_x: p0.tilt_x + (p1.tilt_x - p0.tilt_x) * t,
                    tilt_y: p0.tilt_y + (p1.tilt_y - p0.tilt_y) * t,
                    timestamp_ms: p0.timestamp_ms,
                });
            }
        }

        // Add last point
        if let Some(last) = points.last() {
            result.push(*last);
        }

        result
    }

    /// Catmull-Rom spline interpolation
    fn interpolate_catmull_rom(&self, points: &[RawInputPoint]) -> Vec<RawInputPoint> {
        if points.len() < 4 {
            return self.interpolate_linear(points);
        }

        interpolate_catmull_rom(points, self.settings.size * self.settings.spacing)
    }

    /// Convert a raw input point to a brush point
    fn raw_to_brush_point(&self, raw: &RawInputPoint) -> BrushPoint {
        let pressure = raw.pressure.clamp(0.0, 1.0);

        // Apply pressure curves
        let size = if self.settings.pressure_size {
            self.settings.size * self.settings.size_curve.apply(pressure)
        } else {
            self.settings.size
        };

        let opacity = if self.settings.pressure_opacity {
            self.settings.opacity * self.settings.opacity_curve.apply(pressure)
        } else {
            self.settings.opacity
        };

        // Calculate rotation from tilt
        let rotation = raw.tilt_y.atan2(raw.tilt_x);

        BrushPoint {
            x: raw.x,
            y: raw.y,
            size: size.max(1.0),
            opacity: opacity.clamp(0.0, 1.0),
            rotation,
        }
    }
}

impl Default for BrushEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_points(count: usize) -> Vec<RawInputPoint> {
        (0..count)
            .map(|i| RawInputPoint {
                x: i as f32 * 10.0,
                y: i as f32 * 10.0,
                pressure: 0.5,
                tilt_x: 0.0,
                tilt_y: 0.0,
                timestamp_ms: i as u64,
            })
            .collect()
    }

    #[test]
    fn test_brush_engine_creation() {
        let engine = BrushEngine::new();
        assert_eq!(engine.settings.size, 20.0);
        assert_eq!(engine.settings.opacity, 1.0);
    }

    #[test]
    fn test_process_empty_points() {
        let engine = BrushEngine::new();
        let result = engine.process(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn test_process_single_point() {
        let engine = BrushEngine::new();
        let points = make_test_points(1);
        let result = engine.process(&points);
        assert!(result.is_empty()); // Need at least 2 points
    }

    #[test]
    fn test_process_multiple_points() {
        let engine = BrushEngine::new();
        let points = make_test_points(5);
        let result = engine.process(&points);

        assert_eq!(result.len(), 1);
        assert!(!result[0].points.is_empty());
    }

    #[test]
    fn test_pressure_affects_size() {
        let engine = BrushEngine::new();

        let low_pressure = RawInputPoint::new(0.0, 0.0, 0.2);
        let high_pressure = RawInputPoint::new(0.0, 0.0, 0.8);

        let bp_low = engine.raw_to_brush_point(&low_pressure);
        let bp_high = engine.raw_to_brush_point(&high_pressure);

        assert!(bp_high.size > bp_low.size);
    }
}

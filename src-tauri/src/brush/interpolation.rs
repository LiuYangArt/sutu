//! Interpolation algorithms for smooth brush strokes

use crate::input::RawInputPoint;

/// Interpolation mode for brush strokes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InterpolationMode {
    /// No interpolation
    None,
    /// Linear interpolation
    Linear,
    /// Catmull-Rom spline (smooth curves)
    #[default]
    CatmullRom,
}

/// Catmull-Rom spline interpolation for smooth curves
///
/// This produces natural-looking curves that pass through all control points.
pub fn interpolate_catmull_rom(points: &[RawInputPoint], spacing: f32) -> Vec<RawInputPoint> {
    if points.len() < 4 {
        return points.to_vec();
    }

    let mut result = Vec::with_capacity(points.len() * 8);

    // Process each segment (need 4 points for each segment)
    for i in 0..points.len() - 1 {
        let p0 = if i == 0 { &points[0] } else { &points[i - 1] };
        let p1 = &points[i];
        let p2 = &points[i + 1];
        let p3 = if i + 2 < points.len() {
            &points[i + 2]
        } else {
            &points[points.len() - 1]
        };

        // Calculate segment length for step count
        let dx = p2.x - p1.x;
        let dy = p2.y - p1.y;
        let segment_length = (dx * dx + dy * dy).sqrt();

        let steps = ((segment_length / spacing).ceil() as usize).max(1);

        for step in 0..steps {
            let t = step as f32 / steps as f32;
            let point = catmull_rom_point(p0, p1, p2, p3, t);
            result.push(point);
        }
    }

    // Add the last point
    if let Some(last) = points.last() {
        result.push(*last);
    }

    result
}

/// Calculate a single point on a Catmull-Rom spline
fn catmull_rom_point(
    p0: &RawInputPoint,
    p1: &RawInputPoint,
    p2: &RawInputPoint,
    p3: &RawInputPoint,
    t: f32,
) -> RawInputPoint {
    let t2 = t * t;
    let t3 = t2 * t;

    // Catmull-Rom basis functions
    let b0 = -0.5 * t3 + t2 - 0.5 * t;
    let b1 = 1.5 * t3 - 2.5 * t2 + 1.0;
    let b2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
    let b3 = 0.5 * t3 - 0.5 * t2;

    RawInputPoint {
        x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
        y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
        pressure: b0 * p0.pressure + b1 * p1.pressure + b2 * p2.pressure + b3 * p3.pressure,
        tilt_x: b0 * p0.tilt_x + b1 * p1.tilt_x + b2 * p2.tilt_x + b3 * p3.tilt_x,
        tilt_y: b0 * p0.tilt_y + b1 * p1.tilt_y + b2 * p2.tilt_y + b3 * p3.tilt_y,
        timestamp_ms: p1.timestamp_ms, // Use the start point's timestamp
    }
}

/// Calculate the length of a path through points
pub fn path_length(points: &[RawInputPoint]) -> f32 {
    if points.len() < 2 {
        return 0.0;
    }

    points
        .windows(2)
        .map(|w| {
            let dx = w[1].x - w[0].x;
            let dy = w[1].y - w[0].y;
            (dx * dx + dy * dy).sqrt()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_line_points() -> Vec<RawInputPoint> {
        vec![
            RawInputPoint::new(0.0, 0.0, 0.5),
            RawInputPoint::new(10.0, 0.0, 0.5),
            RawInputPoint::new(20.0, 0.0, 0.5),
            RawInputPoint::new(30.0, 0.0, 0.5),
        ]
    }

    #[test]
    fn test_catmull_rom_interpolation() {
        let points = make_line_points();
        let result = interpolate_catmull_rom(&points, 2.0);

        // Should have more points than input
        assert!(result.len() > points.len());

        // First and last points should be preserved
        assert!((result.first().unwrap().x - points.first().unwrap().x).abs() < 0.01);
        assert!((result.last().unwrap().x - points.last().unwrap().x).abs() < 0.01);
    }

    #[test]
    fn test_path_length() {
        let points = make_line_points();
        let length = path_length(&points);

        // Should be approximately 30 (3 segments of 10 each)
        assert!((length - 30.0).abs() < 0.01);
    }

    #[test]
    fn test_path_length_empty() {
        let points: Vec<RawInputPoint> = vec![];
        assert_eq!(path_length(&points), 0.0);
    }

    #[test]
    fn test_catmull_rom_few_points() {
        // With fewer than 4 points, should return input unchanged
        let points = vec![
            RawInputPoint::new(0.0, 0.0, 0.5),
            RawInputPoint::new(10.0, 10.0, 0.5),
        ];

        let result = interpolate_catmull_rom(&points, 2.0);
        assert_eq!(result.len(), points.len());
    }
}

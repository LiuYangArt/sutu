//! Input processor - filters, deduplicates, and preprocesses input events

use super::RawInputPoint;

/// Configuration for input processing
#[derive(Debug, Clone)]
pub struct InputProcessorConfig {
    /// Minimum distance between points to register (pixels)
    pub min_distance: f32,
    /// Enable point prediction for lower latency
    pub prediction_enabled: bool,
    /// Number of points to use for prediction
    pub prediction_points: usize,
}

impl Default for InputProcessorConfig {
    fn default() -> Self {
        Self {
            min_distance: 1.0,
            prediction_enabled: true,
            prediction_points: 3,
        }
    }
}

/// Processes raw input points before they reach the brush engine
pub struct InputProcessor {
    config: InputProcessorConfig,
    history: Vec<RawInputPoint>,
    last_point: Option<RawInputPoint>,
}

impl InputProcessor {
    /// Create a new input processor with default config
    pub fn new() -> Self {
        Self::with_config(InputProcessorConfig::default())
    }

    /// Create with custom configuration
    pub fn with_config(config: InputProcessorConfig) -> Self {
        Self {
            config,
            history: Vec::with_capacity(16),
            last_point: None,
        }
    }

    /// Process a new input point
    /// Returns Some if the point should be used, None if filtered out
    pub fn process(&mut self, point: RawInputPoint) -> Option<RawInputPoint> {
        // Check minimum distance
        if let Some(last) = self.last_point {
            let dx = point.x - last.x;
            let dy = point.y - last.y;
            let dist = (dx * dx + dy * dy).sqrt();

            if dist < self.config.min_distance {
                return None;
            }
        }

        // Update history for prediction
        self.history.push(point);
        if self.history.len() > self.config.prediction_points {
            self.history.remove(0);
        }

        self.last_point = Some(point);
        Some(point)
    }

    /// Get a predicted next point based on velocity
    pub fn predict_next(&self) -> Option<RawInputPoint> {
        if !self.config.prediction_enabled || self.history.len() < 2 {
            return None;
        }

        let len = self.history.len();
        let p1 = &self.history[len - 2];
        let p2 = &self.history[len - 1];

        // Simple linear prediction
        let vx = p2.x - p1.x;
        let vy = p2.y - p1.y;

        Some(RawInputPoint {
            x: p2.x + vx,
            y: p2.y + vy,
            pressure: p2.pressure,
            tilt_x: p2.tilt_x,
            tilt_y: p2.tilt_y,
            timestamp_ms: p2.timestamp_ms + 8, // Assume ~8ms ahead
        })
    }

    /// Reset the processor state (call when stroke ends)
    pub fn reset(&mut self) {
        self.history.clear();
        self.last_point = None;
    }
}

impl Default for InputProcessor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_min_distance_filter() {
        let mut processor = InputProcessor::with_config(InputProcessorConfig {
            min_distance: 5.0,
            ..Default::default()
        });

        // First point always passes
        let p1 = RawInputPoint::new(0.0, 0.0, 0.5);
        assert!(processor.process(p1).is_some());

        // Too close - should be filtered
        let p2 = RawInputPoint::new(1.0, 1.0, 0.5);
        assert!(processor.process(p2).is_none());

        // Far enough - should pass
        let p3 = RawInputPoint::new(10.0, 10.0, 0.5);
        assert!(processor.process(p3).is_some());
    }

    #[test]
    fn test_prediction() {
        let mut processor = InputProcessor::new();

        processor.process(RawInputPoint::new(0.0, 0.0, 0.5));
        processor.process(RawInputPoint::new(10.0, 10.0, 0.5));

        let predicted = processor.predict_next();
        assert!(predicted.is_some());

        let p = predicted.unwrap();
        assert_eq!(p.x, 20.0);
        assert_eq!(p.y, 20.0);
    }
}

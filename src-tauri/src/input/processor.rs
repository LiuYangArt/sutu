//! Input processor - filters, deduplicates, and preprocesses input events

use std::collections::VecDeque;

use super::RawInputPoint;

/// Pressure smoother - smooths pressure values using a sliding window average.
///
/// Inspired by Krita's `KisIncrementalAverage` (libs/ui/input/wintab/kis_incremental_average.h).
/// Key feature: the first value initializes the entire buffer to avoid first-stroke pressure spikes.
#[derive(Debug, Clone)]
pub struct PressureSmoother {
    window_size: usize,
    values: VecDeque<f32>,
    sum: f32,
    initialized: bool,
}

impl PressureSmoother {
    /// Create a new pressure smoother with the specified window size.
    pub fn new(window_size: usize) -> Self {
        Self {
            window_size: window_size.max(1),
            values: VecDeque::with_capacity(window_size),
            sum: 0.0,
            initialized: false,
        }
    }

    /// Smooth a pressure value.
    ///
    /// Key behavior (from Krita):
    /// - First value initializes the entire buffer with that value
    /// - Subsequent values use sliding window average with O(1) complexity
    pub fn smooth(&mut self, pressure: f32) -> f32 {
        if !self.initialized {
            // Fill the entire buffer with the first value (Krita's approach)
            for _ in 0..self.window_size {
                self.values.push_back(pressure);
            }
            self.sum = pressure * self.window_size as f32;
            self.initialized = true;
            return pressure;
        }

        // Sliding window: remove oldest value
        if let Some(old) = self.values.pop_front() {
            self.sum -= old;
        }

        // Add new value
        self.values.push_back(pressure);
        self.sum += pressure;

        self.sum / self.values.len() as f32
    }

    /// Reset the smoother state (call when stroke ends).
    pub fn reset(&mut self) {
        self.values.clear();
        self.sum = 0.0;
        self.initialized = false;
    }

    /// Check if the smoother has been initialized.
    #[cfg(test)]
    pub fn is_initialized(&self) -> bool {
        self.initialized
    }
}

impl Default for PressureSmoother {
    fn default() -> Self {
        Self::new(3) // Default window size of 3 (same as Krita)
    }
}

/// Configuration for input processing
#[derive(Debug, Clone)]
pub struct InputProcessorConfig {
    /// Minimum distance between points to register (pixels)
    pub min_distance: f32,
    /// Enable point prediction for lower latency
    pub prediction_enabled: bool,
    /// Number of points to use for prediction
    pub prediction_points: usize,
    /// Window size for pressure smoothing (0 to disable)
    pub pressure_smoothing_window: usize,
}

impl Default for InputProcessorConfig {
    fn default() -> Self {
        Self {
            min_distance: 1.0,
            prediction_enabled: true,
            prediction_points: 3,
            pressure_smoothing_window: 3,
        }
    }
}

/// Processes raw input points before they reach the brush engine
pub struct InputProcessor {
    config: InputProcessorConfig,
    history: Vec<RawInputPoint>,
    last_point: Option<RawInputPoint>,
    pressure_smoother: Option<PressureSmoother>,
}

impl InputProcessor {
    /// Create a new input processor with default config
    pub fn new() -> Self {
        Self::with_config(InputProcessorConfig::default())
    }

    /// Create with custom configuration
    pub fn with_config(config: InputProcessorConfig) -> Self {
        let pressure_smoother = if config.pressure_smoothing_window > 0 {
            Some(PressureSmoother::new(config.pressure_smoothing_window))
        } else {
            None
        };

        Self {
            config,
            history: Vec::with_capacity(16),
            last_point: None,
            pressure_smoother,
        }
    }

    /// Process a new input point
    /// Returns Some if the point should be used, None if filtered out
    pub fn process(&mut self, mut point: RawInputPoint) -> Option<RawInputPoint> {
        // Apply pressure smoothing first
        if let Some(ref mut smoother) = self.pressure_smoother {
            point.pressure = smoother.smooth(point.pressure);
        }

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
        if let Some(ref mut smoother) = self.pressure_smoother {
            smoother.reset();
        }
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

    // ===== PressureSmoother Tests =====

    #[test]
    fn test_pressure_smoother_first_value_initialization() {
        let mut smoother = PressureSmoother::new(3);

        // First value should initialize the buffer and return the same value
        assert!(!smoother.is_initialized());
        let result = smoother.smooth(0.5);
        assert!(smoother.is_initialized());
        assert_eq!(result, 0.5);

        // Buffer should be filled with the first value
        assert_eq!(smoother.values.len(), 3);
        assert!(smoother.values.iter().all(|&v| v == 0.5));
    }

    #[test]
    fn test_pressure_smoother_sliding_window() {
        let mut smoother = PressureSmoother::new(3);

        // Initialize with 0.3
        smoother.smooth(0.3);

        // Add 0.6 -> buffer: [0.3, 0.3, 0.6], avg = 0.4
        let result = smoother.smooth(0.6);
        assert!((result - 0.4).abs() < 0.001);

        // Add 0.9 -> buffer: [0.3, 0.6, 0.9], avg = 0.6
        let result = smoother.smooth(0.9);
        assert!((result - 0.6).abs() < 0.001);

        // Add 1.2 (clamped conceptually) -> buffer: [0.6, 0.9, 1.2], avg = 0.9
        let result = smoother.smooth(1.2);
        assert!((result - 0.9).abs() < 0.001);
    }

    #[test]
    fn test_pressure_smoother_reset() {
        let mut smoother = PressureSmoother::new(3);

        smoother.smooth(0.5);
        smoother.smooth(0.7);
        assert!(smoother.is_initialized());

        smoother.reset();

        assert!(!smoother.is_initialized());
        assert!(smoother.values.is_empty());
        assert_eq!(smoother.sum, 0.0);

        // After reset, first value should reinitialize
        let result = smoother.smooth(0.8);
        assert_eq!(result, 0.8);
        assert!(smoother.is_initialized());
    }

    #[test]
    fn test_pressure_smoother_default() {
        let smoother = PressureSmoother::default();
        assert_eq!(smoother.window_size, 3);
        assert!(!smoother.is_initialized());
    }

    // ===== InputProcessor Tests =====

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

        let Some(p) = predicted else {
            panic!("prediction should exist");
        };
        assert_eq!(p.x, 20.0);
        assert_eq!(p.y, 20.0);
    }

    #[test]
    fn test_processor_pressure_smoothing_integration() {
        let mut processor = InputProcessor::with_config(InputProcessorConfig {
            min_distance: 0.0, // Disable distance filter for this test
            pressure_smoothing_window: 3,
            ..Default::default()
        });

        // First point - pressure should be unchanged (initializes buffer)
        let p1 = RawInputPoint::new(0.0, 0.0, 0.3);
        let result1 = processor.process(p1).unwrap();
        assert_eq!(result1.pressure, 0.3);

        // Second point - pressure should be smoothed
        // Buffer: [0.3, 0.3, 0.6], avg = 0.4
        let p2 = RawInputPoint::new(1.0, 0.0, 0.6);
        let result2 = processor.process(p2).unwrap();
        assert!((result2.pressure - 0.4).abs() < 0.001);
    }

    #[test]
    fn test_processor_reset_clears_pressure_smoother() {
        let mut processor = InputProcessor::new();

        processor.process(RawInputPoint::new(0.0, 0.0, 0.5));
        processor.process(RawInputPoint::new(10.0, 10.0, 0.8));

        processor.reset();

        // After reset, first point should reinitialize the smoother
        let p = RawInputPoint::new(0.0, 0.0, 0.2);
        let result = processor.process(p).unwrap();
        assert_eq!(result.pressure, 0.2);
    }

    #[test]
    fn test_processor_disable_pressure_smoothing() {
        let mut processor = InputProcessor::with_config(InputProcessorConfig {
            min_distance: 0.0,
            pressure_smoothing_window: 0, // Disable smoothing
            ..Default::default()
        });

        // Pressure should pass through unchanged
        let p1 = RawInputPoint::new(0.0, 0.0, 0.3);
        let result1 = processor.process(p1).unwrap();
        assert_eq!(result1.pressure, 0.3);

        let p2 = RawInputPoint::new(1.0, 0.0, 0.9);
        let result2 = processor.process(p2).unwrap();
        assert_eq!(result2.pressure, 0.9);
    }
}

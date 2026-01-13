//! Input processor - filters, deduplicates, and preprocesses input events

use std::collections::VecDeque;

use super::RawInputPoint;

/// Pressure smoother - smooths pressure values using a sliding window average.
///
/// Key features:
/// 1. "Soft start" - starts with empty buffer so first high values get dampened
/// 2. "Pressure ramp-up" - first few samples are scaled down to prevent initial spikes
///
/// This combination prevents WinTab first-packet pressure spikes that cause
/// black dots at stroke beginnings.
#[derive(Debug, Clone)]
pub struct PressureSmoother {
    window_size: usize,
    values: VecDeque<f32>,
    sum: f32,
    sample_count: usize,
}

impl PressureSmoother {
    /// Create a new pressure smoother with the specified window size.
    pub fn new(window_size: usize) -> Self {
        let size = window_size.max(1);
        Self {
            window_size: size,
            values: VecDeque::with_capacity(size),
            sum: 0.0,
            sample_count: 0,
        }
    }

    /// Smooth a pressure value.
    ///
    /// Key behaviors:
    /// 1. First 2 samples return 0 (prevents any visible dab at stroke start)
    /// 2. Pressure ramp-up: samples 3-5 are scaled to gradually increase pressure
    /// 3. Soft start: Buffer starts empty, so early values are averaged with fewer samples
    /// 4. Once past ramp-up and buffer is full, uses standard sliding window average
    pub fn smooth(&mut self, pressure: f32) -> f32 {
        self.sample_count += 1;

        // First 2 samples always return 0 to prevent initial dab
        // (tablet often sends multiple packets before pen moves)
        if self.sample_count <= 2 {
            return 0.0;
        }

        // Apply pressure ramp-up factor for samples 3-5
        // Sample 3: factor = 0.25
        // Sample 4: factor = 0.5
        // Sample 5: factor = 0.75
        // Sample 6+: factor = 1.0
        let ramp_factor = match self.sample_count {
            3 => 0.25,
            4 => 0.5,
            5 => 0.75,
            _ => 1.0,
        };
        let ramped_pressure = pressure * ramp_factor;

        // Add ramped value to the buffer
        self.values.push_back(ramped_pressure);
        self.sum += ramped_pressure;

        // If buffer exceeds window size, remove oldest
        if self.values.len() > self.window_size {
            if let Some(old) = self.values.pop_front() {
                self.sum -= old;
            }
        }

        // Return average of current buffer
        self.sum / self.values.len() as f32
    }

    /// Reset the smoother state (call when stroke ends).
    pub fn reset(&mut self) {
        self.values.clear();
        self.sum = 0.0;
        self.sample_count = 0;
    }

    /// Check if the smoother has been initialized (has received at least one sample).
    #[cfg(test)]
    pub fn is_initialized(&self) -> bool {
        self.sample_count > 0
    }

    /// Get the current sample count (for debugging/logging).
    pub fn sample_count(&self) -> usize {
        self.sample_count
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
    fn test_pressure_smoother_soft_start() {
        let mut smoother = PressureSmoother::new(3);

        // First sample: always returns 0 (prevents initial dab)
        assert!(!smoother.is_initialized());
        let result = smoother.smooth(0.9); // High pressure (simulating WinTab spike)
        assert!(smoother.is_initialized());
        assert_eq!(result, 0.0); // First sample is always 0!
        assert_eq!(smoother.values.len(), 0); // Not added to buffer

        // Second sample: also returns 0 (extended silence period)
        let result = smoother.smooth(0.8);
        assert_eq!(result, 0.0);
        assert_eq!(smoother.values.len(), 0); // Still not added to buffer

        // Third sample: ramp_factor = 0.25, so 0.4 * 0.25 = 0.1
        // buffer = [0.1], avg = 0.1
        let result = smoother.smooth(0.4);
        assert!((result - 0.1).abs() < 0.01);
        assert_eq!(smoother.values.len(), 1);

        // Fourth sample: ramp_factor = 0.5, so 0.6 * 0.5 = 0.3
        // buffer = [0.1, 0.3], avg = 0.2
        let result = smoother.smooth(0.6);
        assert!((result - 0.2).abs() < 0.01);
        assert_eq!(smoother.values.len(), 2);

        // Fifth sample: ramp_factor = 0.75, so 0.8 * 0.75 = 0.6
        // buffer = [0.1, 0.3, 0.6], avg = 0.333
        let result = smoother.smooth(0.8);
        assert!((result - 0.333).abs() < 0.01);
        assert_eq!(smoother.values.len(), 3);
    }

    #[test]
    fn test_pressure_smoother_sliding_window() {
        let mut smoother = PressureSmoother::new(3);

        // Build up buffer past ramp-up period
        // Sample 1: returns 0, not added to buffer
        // Sample 2: returns 0, not added to buffer
        // Sample 3: 0.4 * 0.25 = 0.1
        // Sample 4: 0.4 * 0.5 = 0.2
        // Sample 5: 0.4 * 0.75 = 0.3
        // Sample 6: 0.4 * 1.0 = 0.4
        smoother.smooth(0.4); // returns 0
        smoother.smooth(0.4); // returns 0
        smoother.smooth(0.4); // buffer = [0.1], returns 0.1
        smoother.smooth(0.4); // buffer = [0.1, 0.2], returns 0.15
        smoother.smooth(0.4); // buffer = [0.1, 0.2, 0.3], returns 0.2
        smoother.smooth(0.4); // buffer = [0.2, 0.3, 0.4], returns 0.3

        // Now past ramp-up, buffer = [0.2, 0.3, 0.4]
        // Add 0.6 -> buffer: [0.3, 0.4, 0.6], avg = 0.433
        let result = smoother.smooth(0.6);
        assert!((result - 0.433).abs() < 0.01);

        // Add 0.9 -> buffer: [0.4, 0.6, 0.9], avg = 0.633
        let result = smoother.smooth(0.9);
        assert!((result - 0.633).abs() < 0.01);

        // Add 1.2 -> buffer: [0.6, 0.9, 1.2], avg = 0.9
        let result = smoother.smooth(1.2);
        assert!((result - 0.9).abs() < 0.01);
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

        // After reset, first 2 samples return 0 (prevents initial dab)
        let result = smoother.smooth(0.8);
        assert_eq!(result, 0.0);
        assert!(smoother.is_initialized());

        let result2 = smoother.smooth(0.5);
        assert_eq!(result2, 0.0); // Second sample also 0

        // Third sample: 0.6 * 0.25 = 0.15, buffer = [0.15], avg = 0.15
        let result3 = smoother.smooth(0.6);
        assert!((result3 - 0.15).abs() < 0.01);
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

        // First 2 points - returns 0 (prevents initial dab)
        let p1 = RawInputPoint::new(0.0, 0.0, 0.3);
        let result1 = processor.process(p1).unwrap();
        assert_eq!(result1.pressure, 0.0);

        let p2 = RawInputPoint::new(1.0, 0.0, 0.6);
        let result2 = processor.process(p2).unwrap();
        assert_eq!(result2.pressure, 0.0);

        // Third point - ramp_factor = 0.25, so 0.8 * 0.25 = 0.2
        // Buffer: [0.2], avg = 0.2
        let p3 = RawInputPoint::new(2.0, 0.0, 0.8);
        let result3 = processor.process(p3).unwrap();
        assert!((result3.pressure - 0.2).abs() < 0.01);

        // Fourth point - ramp_factor = 0.5, so 0.6 * 0.5 = 0.3
        // Buffer: [0.2, 0.3], avg = 0.25
        let p4 = RawInputPoint::new(3.0, 0.0, 0.6);
        let result4 = processor.process(p4).unwrap();
        assert!((result4.pressure - 0.25).abs() < 0.01);
    }

    #[test]
    fn test_processor_reset_clears_pressure_smoother() {
        let mut processor = InputProcessor::new();

        processor.process(RawInputPoint::new(0.0, 0.0, 0.5));
        processor.process(RawInputPoint::new(10.0, 10.0, 0.8));

        processor.reset();

        // After reset, first point returns 0 (prevents initial dab)
        let p = RawInputPoint::new(0.0, 0.0, 0.2);
        let result = processor.process(p).unwrap();
        assert_eq!(result.pressure, 0.0);
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

//! Input module - handles tablet/pen input processing

mod backend;
mod pointer_backend;
mod processor;
mod tablet;
pub mod wintab_backend;
pub mod wintab_spike;

pub use backend::{
    PressureCurve, TabletBackend, TabletConfig, TabletEvent, TabletInfo, TabletStatus,
};
pub use pointer_backend::PointerEventBackend;
pub use processor::{InputProcessor, PressureSmoother};
pub use tablet::TabletManager;
pub use wintab_backend::WinTabBackend;

use serde::{Deserialize, Serialize};

/// Raw input point from the tablet/pen
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct RawInputPoint {
    /// X coordinate in canvas space
    pub x: f32,
    /// Y coordinate in canvas space
    pub y: f32,
    /// Pressure value (0.0 - 1.0)
    pub pressure: f32,
    /// Tilt X angle in degrees (-90 to 90)
    pub tilt_x: f32,
    /// Tilt Y angle in degrees (-90 to 90)
    pub tilt_y: f32,
    /// Timestamp in milliseconds (high precision)
    pub timestamp_ms: u64,
}

impl RawInputPoint {
    /// Create a new input point
    pub fn new(x: f32, y: f32, pressure: f32) -> Self {
        Self {
            x,
            y,
            pressure: pressure.clamp(0.0, 1.0),
            tilt_x: 0.0,
            tilt_y: 0.0,
            timestamp_ms: current_time_ms(),
        }
    }

    /// Create with full parameters
    pub fn with_tilt(x: f32, y: f32, pressure: f32, tilt_x: f32, tilt_y: f32) -> Self {
        Self {
            x,
            y,
            pressure: pressure.clamp(0.0, 1.0),
            tilt_x: tilt_x.clamp(-90.0, 90.0),
            tilt_y: tilt_y.clamp(-90.0, 90.0),
            timestamp_ms: current_time_ms(),
        }
    }
}

/// Get current time in milliseconds
fn current_time_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_raw_input_point_creation() {
        let point = RawInputPoint::new(100.0, 200.0, 0.5);

        assert_eq!(point.x, 100.0);
        assert_eq!(point.y, 200.0);
        assert_eq!(point.pressure, 0.5);
        assert!(point.timestamp_ms > 0);
    }

    #[test]
    fn test_pressure_clamping() {
        let point = RawInputPoint::new(0.0, 0.0, 1.5);
        assert_eq!(point.pressure, 1.0);

        let point = RawInputPoint::new(0.0, 0.0, -0.5);
        assert_eq!(point.pressure, 0.0);
    }
}

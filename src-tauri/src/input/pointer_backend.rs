//! PointerEvent backend implementation
//!
//! Provides tablet input via the Web PointerEvent API.
//! This is the fallback backend when WinTab is not available.
//! Input is received from the frontend via Tauri commands.

use super::backend::{
    default_event_queue_capacity, InputEventQueue, InputPhase, InputQueueMetrics, InputSampleV2,
    InputSource, TabletBackend, TabletConfig, TabletEventV2, TabletInfo, TabletStatus,
};
use std::sync::Arc;

/// PointerEvent backend for cross-platform tablet input
pub struct PointerEventBackend {
    status: TabletStatus,
    info: Option<TabletInfo>,
    config: TabletConfig,
    events: Arc<InputEventQueue>,
    pressure_curve: super::backend::PressureCurve,
    stream_id: u64,
}

impl PointerEventBackend {
    /// Create a new PointerEvent backend
    pub fn new() -> Self {
        Self {
            status: TabletStatus::Disconnected,
            info: None,
            config: TabletConfig::default(),
            events: Arc::new(InputEventQueue::new(
                super::backend::InputBackpressureMode::Lossless,
                default_event_queue_capacity(),
            )),
            pressure_curve: super::backend::PressureCurve::Linear,
            stream_id: 2,
        }
    }

    /// Push input from frontend PointerEvent
    /// Called by Tauri command when frontend receives pointer events
    #[allow(clippy::too_many_arguments)]
    pub fn push_input(
        &self,
        x: f32,
        y: f32,
        pressure: f32,
        tilt_x: f32,
        tilt_y: f32,
        rotation: f32,
        pointer_id: u32,
        phase: InputPhase,
        device_time_us: Option<u64>,
    ) {
        let adjusted_pressure = self.pressure_curve.apply(pressure);
        let host_time_us = super::current_time_us();

        let sample = InputSampleV2 {
            seq: 0,
            stream_id: self.stream_id,
            source: InputSource::PointerEvent,
            pointer_id,
            phase,
            x,
            y,
            pressure: adjusted_pressure,
            tilt_x: tilt_x.clamp(-90.0, 90.0),
            tilt_y: tilt_y.clamp(-90.0, 90.0),
            rotation,
            host_time_us,
            device_time_us: device_time_us.unwrap_or(host_time_us),
            timestamp_ms: host_time_us / 1000,
        };

        let _ = self.events.enqueue_sample(sample);
    }

    /// Push proximity enter event
    pub fn push_proximity_enter(&self) {
        let _ = self.events.enqueue_event(TabletEventV2::ProximityEnter);
    }

    /// Push proximity leave event
    pub fn push_proximity_leave(&self) {
        let _ = self.events.enqueue_event(TabletEventV2::ProximityLeave);
    }
}

impl Default for PointerEventBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl TabletBackend for PointerEventBackend {
    fn init(&mut self, config: &TabletConfig) -> Result<(), String> {
        self.config = config.clone();
        self.pressure_curve = config.pressure_curve;
        self.events = Arc::new(InputEventQueue::new(
            config.backpressure_mode,
            default_event_queue_capacity(),
        ));

        self.info = Some(TabletInfo {
            name: "PointerEvent".to_string(),
            backend: "PointerEvent".to_string(),
            supports_pressure: true,
            supports_tilt: true,
            pressure_range: (0, 1), // Normalized 0.0-1.0
        });

        self.status = TabletStatus::Connected;
        tracing::info!("[PointerEvent] Initialized");
        Ok(())
    }

    fn start(&mut self) -> Result<(), String> {
        if self.status != TabletStatus::Connected {
            return Err("Backend not initialized".to_string());
        }
        self.events.reopen();
        tracing::info!("[PointerEvent] Started (waiting for frontend events)");
        Ok(())
    }

    fn stop(&mut self) {
        self.events.close();
        self.events.clear();
        tracing::info!("[PointerEvent] Stopped");
    }

    fn status(&self) -> TabletStatus {
        self.status
    }

    fn info(&self) -> Option<&TabletInfo> {
        self.info.as_ref()
    }

    fn poll(&mut self, events: &mut Vec<TabletEventV2>) -> usize {
        self.events.drain_into(events, super::current_time_us)
    }

    fn queue_metrics(&self) -> InputQueueMetrics {
        self.events.metrics_snapshot()
    }

    fn is_available() -> bool {
        // PointerEvent is always available as a fallback
        true
    }

    fn name(&self) -> &'static str {
        "PointerEvent"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pointer_backend_creation() {
        let backend = PointerEventBackend::new();
        assert_eq!(backend.status(), TabletStatus::Disconnected);
        assert!(backend.info().is_none());
    }

    #[test]
    fn test_pointer_backend_init() {
        let mut backend = PointerEventBackend::new();
        let config = TabletConfig::default();

        let result = backend.init(&config);
        assert!(result.is_ok());
        assert_eq!(backend.status(), TabletStatus::Connected);
        assert!(backend.info().is_some());
    }

    #[test]
    fn test_pointer_backend_push_input() -> Result<(), String> {
        let mut backend = PointerEventBackend::new();
        backend.init(&TabletConfig::default())?;
        backend.start()?;

        backend.push_input(
            100.0,
            200.0,
            0.5,
            10.0,
            -5.0,
            0.0,
            1,
            InputPhase::Move,
            None,
        );

        let mut events = Vec::new();
        let count = backend.poll(&mut events);

        assert_eq!(count, 1);
        if let TabletEventV2::Input(sample) = &events[0] {
            assert_eq!(sample.x, 100.0);
            assert_eq!(sample.y, 200.0);
            assert_eq!(sample.pressure, 0.5);
            assert_eq!(sample.pointer_id, 1);
        } else {
            panic!("Expected Input event");
        }
        Ok(())
    }
}

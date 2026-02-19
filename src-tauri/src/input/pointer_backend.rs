//! PointerEvent backend implementation
//!
//! Provides tablet input via the Web PointerEvent API.
//! This is the fallback backend when WinTab is not available.
//! Input is received from the frontend via Tauri commands.

use super::backend::{
    default_event_queue_capacity, InputEventQueue, InputPhase, InputQueueMetrics,
    NativeTabletEventV3, PressureCurve, TabletBackend, TabletConfig, TabletEventV3, TabletInfo,
    TabletStatus,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

/// PointerEvent backend for cross-platform tablet input
pub struct PointerEventBackend {
    status: TabletStatus,
    info: Option<TabletInfo>,
    config: TabletConfig,
    events: Arc<InputEventQueue>,
    pressure_curve: PressureCurve,
    next_stroke_id: AtomicU64,
    active_strokes: Mutex<HashMap<u32, u64>>,
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
            pressure_curve: PressureCurve::Linear,
            next_stroke_id: AtomicU64::new(1),
            active_strokes: Mutex::new(HashMap::new()),
        }
    }

    fn resolve_stroke_id(&self, pointer_id: u32, phase: InputPhase) -> u64 {
        let mut active = match self.active_strokes.lock() {
            Ok(lock) => lock,
            Err(poisoned) => poisoned.into_inner(),
        };

        match phase {
            InputPhase::Down => {
                let stroke_id = self.next_stroke_id.fetch_add(1, Ordering::Relaxed);
                active.insert(pointer_id, stroke_id);
                stroke_id
            }
            InputPhase::Up => active
                .remove(&pointer_id)
                .unwrap_or_else(|| self.next_stroke_id.fetch_add(1, Ordering::Relaxed)),
            InputPhase::Move | InputPhase::Hover => {
                active.get(&pointer_id).copied().unwrap_or_else(|| {
                    let stroke_id = self.next_stroke_id.fetch_add(1, Ordering::Relaxed);
                    active.insert(pointer_id, stroke_id);
                    stroke_id
                })
            }
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
        let stroke_id = self.resolve_stroke_id(pointer_id, phase);

        let sample = NativeTabletEventV3 {
            seq: 0,
            stroke_id,
            pointer_id,
            phase,
            device_id: "pointerevent".to_string(),
            source: super::backend::InputSource::PointerEvent,
            x_px: x,
            y_px: y,
            pressure_0_1: adjusted_pressure,
            tilt_x_deg: tilt_x.clamp(-90.0, 90.0),
            tilt_y_deg: tilt_y.clamp(-90.0, 90.0),
            rotation_deg: rotation.rem_euclid(360.0),
            host_time_us,
            device_time_us: Some(device_time_us.unwrap_or(host_time_us)),
        };

        let _ = self.events.enqueue_sample(sample);
    }

    /// Push proximity enter event
    pub fn push_proximity_enter(&self) {
        let _ = self.events.enqueue_event(TabletEventV3::ProximityEnter);
    }

    /// Push proximity leave event
    pub fn push_proximity_leave(&self) {
        let _ = self.events.enqueue_event(TabletEventV3::ProximityLeave);
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

    fn poll(&mut self, events: &mut Vec<TabletEventV3>) -> usize {
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
        if let TabletEventV3::Input(sample) = &events[0] {
            assert_eq!(sample.x_px, 100.0);
            assert_eq!(sample.y_px, 200.0);
            assert_eq!(sample.pressure_0_1, 0.5);
            assert_eq!(sample.pointer_id, 1);
        } else {
            panic!("Expected Input event");
        }
        Ok(())
    }
}

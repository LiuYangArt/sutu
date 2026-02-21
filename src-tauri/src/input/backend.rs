//! TabletBackend trait - unified interface for tablet input backends
//!
//! This module defines the common interface that all tablet backends must implement,
//! allowing seamless switching between WinTab, PointerEvent, and other backends.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

pub use super::krita_v3::types::{
    InputPhaseV3 as InputPhase, InputSourceV3 as InputSource, NativeTabletEventV3,
};

/// Tablet device information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabletInfo {
    /// Device name
    pub name: String,
    /// Backend type (e.g., "WinTab", "PointerEvent")
    pub backend: String,
    /// Whether pressure is supported
    pub supports_pressure: bool,
    /// Whether tilt is supported
    pub supports_tilt: bool,
    /// Pressure range (min, max)
    pub pressure_range: (i32, i32),
}

/// Tablet connection status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TabletStatus {
    /// Not connected or not initialized
    Disconnected,
    /// Connected and ready
    Connected,
    /// Connection failed
    Error,
}

/// Events emitted by the tablet backend (V3 payloads).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TabletEventV3 {
    /// Input point received
    Input(NativeTabletEventV3),
    /// Pen entered proximity
    ProximityEnter,
    /// Pen left proximity
    ProximityLeave,
    /// Status changed
    StatusChanged(TabletStatus),
}

/// Queue backpressure mode for tablet input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputBackpressureMode {
    /// Block producer when queue is full. No sample drop by policy.
    Lossless,
    /// Keep latency bounded by dropping oldest queued samples when full.
    LatencyCapped,
}

impl InputBackpressureMode {
    fn as_u8(self) -> u8 {
        match self {
            Self::Lossless => 0,
            Self::LatencyCapped => 1,
        }
    }
}

impl From<u8> for InputBackpressureMode {
    fn from(value: u8) -> Self {
        match value {
            1 => Self::LatencyCapped,
            _ => Self::Lossless,
        }
    }
}

/// Public queue metrics for status response / telemetry.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InputQueueMetrics {
    pub enqueued: u64,
    pub dequeued: u64,
    pub dropped: u64,
    pub max_depth: usize,
    pub current_depth: usize,
    pub latency_p50_us: u64,
    pub latency_p95_us: u64,
    pub latency_p99_us: u64,
    pub latency_last_us: u64,
}

/// Runtime diagnostics snapshot for V3 tablet pipeline.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TabletV3Diagnostics {
    pub phase_transition_error_count: u64,
    pub host_time_non_monotonic_count: u64,
    pub stroke_tail_drop_count: u64,
    pub native_down_without_seed_count: u64,
    pub coord_out_of_view_count: u64,
    pub seq_rewind_recovery_fail_count: u64,
    pub pressure_clamp_count: u64,
    pub pressure_total_count: u64,
}

const LATENCY_HISTORY_LIMIT: usize = 1024;
const LOSSLESS_WAIT_SLICE_MS: u64 = 10;
const DEFAULT_EVENT_QUEUE_CAPACITY: usize = 2048;

pub fn default_event_queue_capacity() -> usize {
    DEFAULT_EVENT_QUEUE_CAPACITY
}

#[derive(Debug)]
struct InputQueueState {
    events: VecDeque<TabletEventV3>,
    next_seq: u64,
    closed: bool,
    enqueued: u64,
    dequeued: u64,
    dropped: u64,
    max_depth: usize,
    latency_last_us: u64,
    latency_history_us: VecDeque<u64>,
}

impl InputQueueState {
    fn new() -> Self {
        Self {
            events: VecDeque::new(),
            next_seq: 1,
            closed: false,
            enqueued: 0,
            dequeued: 0,
            dropped: 0,
            max_depth: 0,
            latency_last_us: 0,
            latency_history_us: VecDeque::with_capacity(LATENCY_HISTORY_LIMIT),
        }
    }

    fn push_latency(&mut self, latency_us: u64) {
        self.latency_last_us = latency_us;
        if self.latency_history_us.len() >= LATENCY_HISTORY_LIMIT {
            let _ = self.latency_history_us.pop_front();
        }
        self.latency_history_us.push_back(latency_us);
    }
}

#[derive(Debug)]
pub struct InputEventQueue {
    mode: InputBackpressureMode,
    capacity: usize,
    inner: Mutex<InputQueueState>,
    wake: Condvar,
}

impl InputEventQueue {
    pub fn new(mode: InputBackpressureMode, capacity: usize) -> Self {
        Self {
            mode,
            capacity: capacity.max(1),
            inner: Mutex::new(InputQueueState::new()),
            wake: Condvar::new(),
        }
    }

    pub fn mode(&self) -> InputBackpressureMode {
        self.mode
    }

    pub fn reopen(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.closed = false;
        }
    }

    pub fn close(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.closed = true;
            self.wake.notify_all();
        }
    }

    pub fn clear(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.events.clear();
            self.wake.notify_all();
        }
    }

    pub fn enqueue_sample(&self, mut sample: NativeTabletEventV3) -> bool {
        let mut guard = match self.inner.lock() {
            Ok(lock) => lock,
            Err(poisoned) => poisoned.into_inner(),
        };

        if guard.closed {
            return false;
        }

        if self.mode == InputBackpressureMode::Lossless {
            while guard.events.len() >= self.capacity && !guard.closed {
                let wait_result = self
                    .wake
                    .wait_timeout(guard, Duration::from_millis(LOSSLESS_WAIT_SLICE_MS));
                guard = match wait_result {
                    Ok((lock, _)) => lock,
                    Err(poisoned) => poisoned.into_inner().0,
                };
            }
            if guard.closed {
                return false;
            }
        } else if guard.events.len() >= self.capacity {
            let mut dropped_now = 0u64;
            while guard.events.len() >= self.capacity {
                if guard.events.pop_front().is_some() {
                    dropped_now += 1;
                } else {
                    break;
                }
            }
            guard.dropped += dropped_now;
        }

        sample.seq = guard.next_seq;
        guard.next_seq = guard.next_seq.saturating_add(1);
        sample.pressure_0_1 = sample.pressure_0_1.clamp(0.0, 1.0);
        sample.tilt_x_deg = sample.tilt_x_deg.clamp(-90.0, 90.0);
        sample.tilt_y_deg = sample.tilt_y_deg.clamp(-90.0, 90.0);
        sample.rotation_deg = if sample.rotation_deg.is_finite() {
            sample.rotation_deg.rem_euclid(360.0)
        } else {
            0.0
        };
        if sample.device_time_us.is_none() {
            sample.device_time_us = Some(sample.host_time_us);
        }

        guard.events.push_back(TabletEventV3::Input(sample));
        guard.enqueued = guard.enqueued.saturating_add(1);
        guard.max_depth = guard.max_depth.max(guard.events.len());
        true
    }

    pub fn enqueue_event(&self, event: TabletEventV3) -> bool {
        let mut guard = match self.inner.lock() {
            Ok(lock) => lock,
            Err(poisoned) => poisoned.into_inner(),
        };
        if guard.closed {
            return false;
        }
        guard.events.push_back(event);
        guard.max_depth = guard.max_depth.max(guard.events.len());
        true
    }

    pub fn drain_into<F>(&self, out: &mut Vec<TabletEventV3>, now_us: F) -> usize
    where
        F: Fn() -> u64,
    {
        let mut guard = match self.inner.lock() {
            Ok(lock) => lock,
            Err(poisoned) => poisoned.into_inner(),
        };
        let count = guard.events.len();
        while let Some(event) = guard.events.pop_front() {
            if let TabletEventV3::Input(sample) = &event {
                let latency_us = now_us().saturating_sub(sample.host_time_us);
                guard.push_latency(latency_us);
                guard.dequeued = guard.dequeued.saturating_add(1);
            }
            out.push(event);
        }
        self.wake.notify_all();
        count
    }

    pub fn metrics_snapshot(&self) -> InputQueueMetrics {
        let guard = match self.inner.lock() {
            Ok(lock) => lock,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut latencies = guard
            .latency_history_us
            .iter()
            .copied()
            .collect::<Vec<u64>>();
        latencies.sort_unstable();

        let quantile = |p: f64| -> u64 {
            if latencies.is_empty() {
                return 0;
            }
            let idx = ((latencies.len() - 1) as f64 * p).round() as usize;
            latencies[idx.min(latencies.len() - 1)]
        };

        InputQueueMetrics {
            enqueued: guard.enqueued,
            dequeued: guard.dequeued,
            dropped: guard.dropped,
            max_depth: guard.max_depth,
            current_depth: guard.events.len(),
            latency_p50_us: quantile(0.50),
            latency_p95_us: quantile(0.95),
            latency_p99_us: quantile(0.99),
            latency_last_us: guard.latency_last_us,
        }
    }

    pub fn backpressure_mode_id(&self) -> u8 {
        self.mode.as_u8()
    }
}

/// Configuration for tablet backend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabletConfig {
    /// Polling rate in Hz (for polling-based backends)
    pub polling_rate_hz: u32,
    /// Enable input prediction
    pub prediction_enabled: bool,
    /// Pressure curve type
    pub pressure_curve: PressureCurve,
    /// Queue backpressure mode.
    pub backpressure_mode: InputBackpressureMode,
}

impl Default for TabletConfig {
    fn default() -> Self {
        Self {
            polling_rate_hz: 200,
            prediction_enabled: true,
            pressure_curve: PressureCurve::Linear,
            backpressure_mode: InputBackpressureMode::Lossless,
        }
    }
}

/// Pressure curve types for mapping raw pressure to output
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PressureCurve {
    /// Linear mapping (1:1)
    Linear,
    /// Soft curve (easier light pressure)
    Soft,
    /// Hard curve (requires more pressure)
    Hard,
    /// S-curve (soft at extremes, linear in middle)
    SCurve,
}

impl PressureCurve {
    /// Apply the pressure curve to a normalized pressure value (0.0 - 1.0)
    pub fn apply(&self, pressure: f32) -> f32 {
        let p = pressure.clamp(0.0, 1.0);
        match self {
            PressureCurve::Linear => p,
            PressureCurve::Soft => p.sqrt(),
            PressureCurve::Hard => p * p,
            PressureCurve::SCurve => {
                // S-curve using smoothstep
                p * p * (3.0 - 2.0 * p)
            }
        }
    }
}

/// Trait that all tablet backends must implement
pub trait TabletBackend: Send {
    /// Initialize the backend
    fn init(&mut self, config: &TabletConfig) -> Result<(), String>;

    /// Start receiving input events
    fn start(&mut self) -> Result<(), String>;

    /// Stop receiving input events
    fn stop(&mut self);

    /// Get current status
    fn status(&self) -> TabletStatus;

    /// Get tablet info (if connected)
    fn info(&self) -> Option<&TabletInfo>;

    /// Poll for new events (for polling-based backends)
    /// Returns the number of events retrieved
    fn poll(&mut self, events: &mut Vec<TabletEventV3>) -> usize;

    /// Queue telemetry metrics for diagnostics/status response.
    fn queue_metrics(&self) -> InputQueueMetrics;

    /// V3 diagnostics snapshot for Krita-parity input pipeline.
    fn v3_diagnostics(&self) -> TabletV3Diagnostics {
        TabletV3Diagnostics::default()
    }

    /// Check if this backend is available on the current system
    fn is_available() -> bool
    where
        Self: Sized;

    /// Get the backend name
    fn name(&self) -> &'static str;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    fn make_sample(host_time_us: u64) -> NativeTabletEventV3 {
        NativeTabletEventV3 {
            seq: 0,
            stroke_id: 1,
            pointer_id: 0,
            device_id: "test-device".to_string(),
            source: InputSource::WinTab,
            phase: InputPhase::Move,
            x_px: 100.0,
            y_px: 200.0,
            pressure_0_1: 0.5,
            tilt_x_deg: 0.0,
            tilt_y_deg: 0.0,
            rotation_deg: 0.0,
            host_time_us,
            device_time_us: Some(host_time_us),
        }
    }

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
        assert!(curve.apply(0.25) > 0.25); // Soft makes low pressure easier
        assert_eq!(curve.apply(1.0), 1.0);
    }

    #[test]
    fn test_pressure_curve_hard() {
        let curve = PressureCurve::Hard;
        assert_eq!(curve.apply(0.0), 0.0);
        assert!(curve.apply(0.5) < 0.5); // Hard makes low pressure harder
        assert_eq!(curve.apply(1.0), 1.0);
    }

    #[test]
    fn test_pressure_curve_clamping() {
        let curve = PressureCurve::Linear;
        assert_eq!(curve.apply(-0.5), 0.0);
        assert_eq!(curve.apply(1.5), 1.0);
    }

    #[test]
    fn test_lossless_queue_has_no_drops_under_concurrency() {
        let queue = Arc::new(InputEventQueue::new(InputBackpressureMode::Lossless, 64));
        queue.reopen();

        const PRODUCERS: usize = 4;
        const PER_PRODUCER: usize = 300;
        const TOTAL: usize = PRODUCERS * PER_PRODUCER;

        let mut producer_handles = Vec::new();
        for producer_idx in 0..PRODUCERS {
            let queue_clone = queue.clone();
            producer_handles.push(thread::spawn(move || {
                for offset in 0..PER_PRODUCER {
                    let host_time_us = ((producer_idx * PER_PRODUCER + offset) as u64) * 1000;
                    assert!(queue_clone.enqueue_sample(make_sample(host_time_us)));
                }
            }));
        }

        let queue_for_consumer = queue.clone();
        let consumer = thread::spawn(move || {
            let mut consumed = 0usize;
            let mut buffer = Vec::with_capacity(128);
            while consumed < TOTAL {
                buffer.clear();
                let count = queue_for_consumer.drain_into(&mut buffer, || 10_000_000);
                consumed += count;
                if count == 0 {
                    thread::yield_now();
                }
            }
        });

        for handle in producer_handles {
            handle.join().expect("producer thread panicked");
        }
        consumer.join().expect("consumer thread panicked");

        let metrics = queue.metrics_snapshot();
        assert_eq!(metrics.enqueued, TOTAL as u64);
        assert_eq!(metrics.dequeued, TOTAL as u64);
        assert_eq!(metrics.dropped, 0);
    }

    #[test]
    fn test_latency_capped_queue_drops_oldest_and_keeps_monotonic_seq() {
        let queue = InputEventQueue::new(InputBackpressureMode::LatencyCapped, 8);
        queue.reopen();

        for i in 0..128u64 {
            assert!(queue.enqueue_sample(make_sample(i * 1000)));
        }

        let metrics = queue.metrics_snapshot();
        assert!(metrics.dropped > 0);
        assert!(metrics.current_depth <= 8);

        let mut drained = Vec::new();
        let _ = queue.drain_into(&mut drained, || 1_000_000);
        let mut prev_seq = 0u64;
        for event in drained {
            if let TabletEventV3::Input(sample) = event {
                assert!(sample.seq > prev_seq);
                prev_seq = sample.seq;
            }
        }
    }

    #[test]
    fn test_input_source_mac_native_serialization() {
        let encoded = serde_json::to_string(&InputSource::MacNative).expect("serialize source");
        assert_eq!(encoded, "\"mac_native\"");

        let decoded: InputSource =
            serde_json::from_str("\"mac_native\"").expect("deserialize source");
        assert_eq!(decoded, InputSource::MacNative);
    }
}

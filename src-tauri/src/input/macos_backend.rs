//! macOS native tablet backend implementation.
//!
//! Uses AppKit `NSEvent` local monitors to capture tablet pressure/tilt/rotation/proximity
//! and feeds them into the existing `tablet-event-v2` queue.

use super::backend::{
    default_event_queue_capacity, InputEventQueue, InputPhase, InputQueueMetrics, InputSampleV2,
    InputSource, TabletBackend, TabletConfig, TabletEventV2, TabletInfo, TabletStatus,
};
use std::sync::Arc;

const MAC_NATIVE_STREAM_ID: u64 = 3;
const MONITOR_SETUP_TIMEOUT_MS: u64 = 2_000;
const MONITOR_TEARDOWN_TIMEOUT_MS: u64 = 500;

fn normalize_pressure(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

fn normalize_tilt_component(value: f64) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    (value * 90.0).clamp(-90.0, 90.0) as f32
}

fn normalize_rotation_degrees(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.rem_euclid(360.0)
}

fn normalize_device_timestamp_us(timestamp_seconds: f64, fallback_host_time_us: u64) -> u64 {
    if !timestamp_seconds.is_finite() || timestamp_seconds < 0.0 {
        return fallback_host_time_us;
    }
    (timestamp_seconds * 1_000_000.0).max(0.0) as u64
}

fn normalize_pointer_id(raw_pointer_id: u64) -> u32 {
    if raw_pointer_id > u32::MAX as u64 {
        u32::MAX
    } else {
        raw_pointer_id as u32
    }
}

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use core::ptr::NonNull;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::AnyObject;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSEvent, NSEventMask, NSEventType};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
#[cfg(target_os = "macos")]
use std::time::Duration;
#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct MonitorRuntime {
    events: Arc<InputEventQueue>,
    collecting: AtomicBool,
    pointer_down: AtomicBool,
}

#[cfg(target_os = "macos")]
impl MonitorRuntime {
    fn new(events: Arc<InputEventQueue>) -> Self {
        Self {
            events,
            collecting: AtomicBool::new(false),
            pointer_down: AtomicBool::new(false),
        }
    }

    fn process_event(&self, event: &NSEvent, stream_id: u64) {
        if !self.collecting.load(Ordering::Relaxed) {
            return;
        }

        match event.r#type() {
            NSEventType::TabletProximity => {
                if event.isEnteringProximity() {
                    let _ = self.events.enqueue_event(TabletEventV2::ProximityEnter);
                } else {
                    self.pointer_down.store(false, Ordering::Relaxed);
                    let _ = self.events.enqueue_event(TabletEventV2::ProximityLeave);
                }
            }
            NSEventType::LeftMouseDown | NSEventType::OtherMouseDown => {
                self.pointer_down.store(true, Ordering::Relaxed);
                self.enqueue_sample(event, stream_id, InputPhase::Down, None);
            }
            NSEventType::LeftMouseDragged | NSEventType::OtherMouseDragged => {
                self.enqueue_sample(event, stream_id, InputPhase::Move, None);
            }
            NSEventType::LeftMouseUp | NSEventType::OtherMouseUp | NSEventType::MouseCancelled => {
                self.pointer_down.store(false, Ordering::Relaxed);
                self.enqueue_sample(event, stream_id, InputPhase::Up, Some(0.0));
            }
            NSEventType::TabletPoint => {
                let pressure = normalize_pressure(event.pressure());
                let phase = if pressure > 0.0 {
                    if self.pointer_down.swap(true, Ordering::Relaxed) {
                        InputPhase::Move
                    } else {
                        InputPhase::Down
                    }
                } else if self.pointer_down.swap(false, Ordering::Relaxed) {
                    InputPhase::Up
                } else {
                    InputPhase::Hover
                };
                self.enqueue_sample(event, stream_id, phase, Some(pressure));
            }
            _ => {}
        }
    }

    fn enqueue_sample(
        &self,
        event: &NSEvent,
        stream_id: u64,
        phase: InputPhase,
        pressure_override: Option<f32>,
    ) {
        let location = event.locationInWindow();
        let tilt = event.tilt();
        let host_time_us = super::current_time_us();
        let pressure = pressure_override.unwrap_or_else(|| normalize_pressure(event.pressure()));
        let sample = InputSampleV2 {
            seq: 0,
            stream_id,
            source: InputSource::MacNative,
            pointer_id: normalize_pointer_id(event.pointingDeviceID() as u64),
            phase,
            x: location.x as f32,
            y: location.y as f32,
            pressure,
            tilt_x: normalize_tilt_component(tilt.x),
            tilt_y: normalize_tilt_component(tilt.y),
            rotation: normalize_rotation_degrees(event.rotation()),
            host_time_us,
            device_time_us: normalize_device_timestamp_us(event.timestamp(), host_time_us),
            timestamp_ms: host_time_us / 1000,
        };
        let _ = self.events.enqueue_sample(sample);
    }
}

#[cfg(target_os = "macos")]
pub struct MacNativeBackend {
    status: TabletStatus,
    info: Option<TabletInfo>,
    config: TabletConfig,
    events: Arc<InputEventQueue>,
    app_handle: tauri::AppHandle,
    runtime: Arc<MonitorRuntime>,
    monitor_token_raw: Option<usize>,
    stream_id: u64,
}

#[cfg(target_os = "macos")]
impl MacNativeBackend {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        let events = Arc::new(InputEventQueue::new(
            super::backend::InputBackpressureMode::Lossless,
            default_event_queue_capacity(),
        ));
        let runtime = Arc::new(MonitorRuntime::new(events.clone()));
        Self {
            status: TabletStatus::Disconnected,
            info: None,
            config: TabletConfig::default(),
            events,
            app_handle,
            runtime,
            monitor_token_raw: None,
            stream_id: MAC_NATIVE_STREAM_ID,
        }
    }

    fn rebuild_queue_from_config(&mut self) {
        self.events = Arc::new(InputEventQueue::new(
            self.config.backpressure_mode,
            default_event_queue_capacity(),
        ));
        self.runtime = Arc::new(MonitorRuntime::new(self.events.clone()));
    }

    fn install_monitor(&mut self) -> Result<(), String> {
        if self.monitor_token_raw.is_some() {
            return Ok(());
        }

        let Some(main_window) = self.app_handle.get_webview_window("main") else {
            return Err("Main webview window not found".to_string());
        };

        let runtime = self.runtime.clone();
        let stream_id = self.stream_id;
        let (tx, rx) = mpsc::channel::<Result<usize, String>>();

        main_window
            .with_webview(move |webview| {
                let result = (|| -> Result<usize, String> {
                    let webview_ptr = webview.inner();
                    let window_ptr = webview.ns_window();
                    if webview_ptr.is_null() || window_ptr.is_null() {
                        return Err("Invalid WKWebView/NSWindow pointer".to_string());
                    }

                    let mask = NSEventMask::TabletPoint
                        | NSEventMask::TabletProximity
                        | NSEventMask::LeftMouseDown
                        | NSEventMask::LeftMouseDragged
                        | NSEventMask::LeftMouseUp
                        | NSEventMask::OtherMouseDown
                        | NSEventMask::OtherMouseDragged
                        | NSEventMask::OtherMouseUp
                        | NSEventMask::MouseCancelled;

                    let handler =
                        RcBlock::new(move |event_ptr: NonNull<NSEvent>| -> *mut NSEvent {
                            let event = unsafe { event_ptr.as_ref() };
                            runtime.process_event(event, stream_id);
                            event_ptr.as_ptr()
                        });

                    let monitor = unsafe {
                        NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &handler)
                    }
                    .ok_or_else(|| "Failed to register NSEvent local monitor".to_string())?;

                    Ok(Retained::into_raw(monitor) as usize)
                })();
                let _ = tx.send(result);
            })
            .map_err(|e| format!("Failed to schedule webview monitor install: {e}"))?;

        let token_raw = rx
            .recv_timeout(Duration::from_millis(MONITOR_SETUP_TIMEOUT_MS))
            .map_err(|_| "Timed out waiting for macOS monitor installation".to_string())??;

        self.monitor_token_raw = Some(token_raw);
        Ok(())
    }

    fn uninstall_monitor(&mut self) {
        let Some(raw) = self.monitor_token_raw.take() else {
            return;
        };

        let Some(main_window) = self.app_handle.get_webview_window("main") else {
            unsafe {
                drop(Retained::from_raw(raw as *mut AnyObject));
            }
            return;
        };

        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let schedule_result = main_window.with_webview(move |_webview| {
            let remove_result = (|| -> Result<(), String> {
                let monitor_ptr = raw as *mut AnyObject;
                if monitor_ptr.is_null() {
                    return Ok(());
                }
                unsafe {
                    NSEvent::removeMonitor(&*monitor_ptr);
                    drop(Retained::from_raw(monitor_ptr));
                }
                Ok(())
            })();
            let _ = tx.send(remove_result);
        });

        if let Err(err) = schedule_result {
            tracing::warn!("[MacNative] Failed to schedule monitor removal: {}", err);
            unsafe {
                drop(Retained::from_raw(raw as *mut AnyObject));
            }
            return;
        }

        match rx.recv_timeout(Duration::from_millis(MONITOR_TEARDOWN_TIMEOUT_MS)) {
            Ok(Err(err)) => {
                tracing::warn!("[MacNative] Failed to remove local monitor: {}", err);
            }
            Err(_) => {
                tracing::warn!("[MacNative] Timed out waiting for monitor teardown");
            }
            Ok(Ok(())) => {}
        }
    }
}

#[cfg(target_os = "macos")]
impl TabletBackend for MacNativeBackend {
    fn init(&mut self, config: &TabletConfig) -> Result<(), String> {
        self.config = config.clone();
        self.rebuild_queue_from_config();
        self.info = Some(TabletInfo {
            name: "macOS Native Tablet".to_string(),
            backend: "MacNative".to_string(),
            supports_pressure: true,
            supports_tilt: true,
            pressure_range: (0, 1),
        });
        self.status = TabletStatus::Connected;
        tracing::info!("[MacNative] Initialized");
        Ok(())
    }

    fn start(&mut self) -> Result<(), String> {
        if self.status != TabletStatus::Connected {
            return Err("Backend not initialized".to_string());
        }

        self.events.reopen();
        self.runtime.pointer_down.store(false, Ordering::Relaxed);
        self.runtime.collecting.store(true, Ordering::Relaxed);

        if let Err(err) = self.install_monitor() {
            self.runtime.collecting.store(false, Ordering::Relaxed);
            self.events.close();
            self.events.clear();
            return Err(err);
        }

        tracing::info!("[MacNative] Started");
        Ok(())
    }

    fn stop(&mut self) {
        self.runtime.collecting.store(false, Ordering::Relaxed);
        self.runtime.pointer_down.store(false, Ordering::Relaxed);
        self.events.close();
        self.uninstall_monitor();
        self.events.clear();
        tracing::info!("[MacNative] Stopped");
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
        true
    }

    fn name(&self) -> &'static str {
        "MacNative"
    }
}

#[cfg(not(target_os = "macos"))]
pub struct MacNativeBackend {
    status: TabletStatus,
    info: Option<TabletInfo>,
}

#[cfg(not(target_os = "macos"))]
impl MacNativeBackend {
    pub fn new(_app_handle: tauri::AppHandle) -> Self {
        Self {
            status: TabletStatus::Disconnected,
            info: None,
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl TabletBackend for MacNativeBackend {
    fn init(&mut self, _config: &TabletConfig) -> Result<(), String> {
        Err("MacNative backend is only available on macOS".to_string())
    }

    fn start(&mut self) -> Result<(), String> {
        Err("MacNative backend is only available on macOS".to_string())
    }

    fn stop(&mut self) {}

    fn status(&self) -> TabletStatus {
        self.status
    }

    fn info(&self) -> Option<&TabletInfo> {
        self.info.as_ref()
    }

    fn poll(&mut self, _events: &mut Vec<TabletEventV2>) -> usize {
        0
    }

    fn queue_metrics(&self) -> InputQueueMetrics {
        InputQueueMetrics::default()
    }

    fn is_available() -> bool {
        false
    }

    fn name(&self) -> &'static str {
        "MacNative"
    }
}

impl Drop for MacNativeBackend {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pressure_normalization_clamps_to_unit_range() {
        assert_eq!(normalize_pressure(-0.2), 0.0);
        assert_eq!(normalize_pressure(0.4), 0.4);
        assert_eq!(normalize_pressure(1.8), 1.0);
    }

    #[test]
    fn test_tilt_component_normalization_scales_and_clamps() {
        assert_eq!(normalize_tilt_component(-2.0), -90.0);
        assert_eq!(normalize_tilt_component(-0.5), -45.0);
        assert_eq!(normalize_tilt_component(0.25), 22.5);
        assert_eq!(normalize_tilt_component(2.0), 90.0);
    }

    #[test]
    fn test_rotation_normalization_wraps_to_360() {
        assert_eq!(normalize_rotation_degrees(-30.0), 330.0);
        assert_eq!(normalize_rotation_degrees(30.0), 30.0);
        assert_eq!(normalize_rotation_degrees(390.0), 30.0);
    }
}

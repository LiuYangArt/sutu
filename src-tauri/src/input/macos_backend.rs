//! macOS native tablet backend implementation.
//!
//! Uses AppKit `NSEvent` local monitors to capture tablet pressure/tilt/rotation/proximity
//! and feeds them into the V3 tablet queue.

#[cfg(target_os = "macos")]
use super::backend::{default_event_queue_capacity, InputEventQueue, TabletV3Diagnostics};
use super::backend::{
    InputQueueMetrics, TabletBackend, TabletConfig, TabletEventV3, TabletInfo, TabletStatus,
};
#[cfg(target_os = "macos")]
use super::krita_v3::{MacNativeAdapterV3, MacNativeEventKind, MacNativeRawSample};
#[cfg(target_os = "macos")]
use std::sync::Arc;

#[cfg(target_os = "macos")]
const MONITOR_SETUP_TIMEOUT_MS: u64 = 2_000;
#[cfg(target_os = "macos")]
const MONITOR_TEARDOWN_TIMEOUT_MS: u64 = 500;

#[cfg(any(target_os = "macos", test))]
fn normalize_pressure(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

#[cfg(any(target_os = "macos", test))]
fn normalize_tilt_component(value: f64) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    (value * 90.0).clamp(-90.0, 90.0) as f32
}

#[cfg(any(target_os = "macos", test))]
fn normalize_rotation_degrees(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.rem_euclid(360.0)
}

#[cfg(target_os = "macos")]
fn normalize_device_timestamp_us(timestamp_seconds: f64, fallback_host_time_us: u64) -> u64 {
    if !timestamp_seconds.is_finite() || timestamp_seconds < 0.0 {
        return fallback_host_time_us;
    }
    (timestamp_seconds * 1_000_000.0).max(0.0) as u64
}

#[cfg(target_os = "macos")]
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
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSEvent, NSEventMask, NSEventType};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
#[cfg(target_os = "macos")]
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::time::Duration;
#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct MonitorRuntime {
    events: Arc<InputEventQueue>,
    collecting: AtomicBool,
    in_proximity: AtomicBool,
    adapter: Mutex<MacNativeAdapterV3>,
}

#[cfg(target_os = "macos")]
impl MonitorRuntime {
    fn new(events: Arc<InputEventQueue>) -> Self {
        Self {
            events,
            collecting: AtomicBool::new(false),
            in_proximity: AtomicBool::new(false),
            adapter: Mutex::new(MacNativeAdapterV3::new("macnative".to_string(), 1.0, 1.0)),
        }
    }

    fn with_adapter<R>(&self, f: impl FnOnce(&mut MacNativeAdapterV3) -> R) -> R {
        let mut adapter = match self.adapter.lock() {
            Ok(lock) => lock,
            Err(poisoned) => poisoned.into_inner(),
        };
        f(&mut adapter)
    }

    fn update_viewport_size(&self, width_px: f32, height_px: f32) {
        self.with_adapter(|adapter| {
            adapter.update_viewport_size(width_px, height_px);
        });
    }

    fn reset_adapter(&self) {
        self.with_adapter(|adapter| {
            adapter.reset();
        });
    }

    fn diagnostics_snapshot(&self) -> TabletV3Diagnostics {
        self.with_adapter(|adapter| adapter.diagnostics_snapshot())
    }

    fn update_viewport_size_from_event_window(&self, event: &NSEvent) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(window) = event.window(mtm) else {
            return;
        };
        let frame = window.frame();
        // We need the actual drawable layout height for WebView client coordinates.
        // In windowed mode, title/toolbar area can add a constant top inset (for example +64 px)
        // if we use frame/content size directly.
        let layout_rect = window.contentLayoutRect();
        let mut width_px = layout_rect.size.width as f32;
        let mut height_px = layout_rect.size.height as f32;
        if !width_px.is_finite() || !height_px.is_finite() || width_px <= 0.0 || height_px <= 0.0 {
            let content_rect = window.contentRectForFrameRect(frame);
            width_px = content_rect.size.width as f32;
            height_px = content_rect.size.height as f32;
        }
        if !width_px.is_finite() || !height_px.is_finite() || width_px <= 0.0 || height_px <= 0.0 {
            width_px = frame.size.width as f32;
            height_px = frame.size.height as f32;
        }
        if !width_px.is_finite() || !height_px.is_finite() {
            return;
        }
        self.update_viewport_size(width_px.max(1.0), height_px.max(1.0));
    }

    fn process_event(&self, event: &NSEvent) {
        if !self.collecting.load(Ordering::Relaxed) {
            return;
        }

        self.update_viewport_size_from_event_window(event);
        match event.r#type() {
            NSEventType::TabletProximity => {
                if event.isEnteringProximity() {
                    self.in_proximity.store(true, Ordering::Relaxed);
                    let _ = self.events.enqueue_event(TabletEventV3::ProximityEnter);
                } else {
                    self.in_proximity.store(false, Ordering::Relaxed);
                    let _ = self.events.enqueue_event(TabletEventV3::ProximityLeave);
                }
            }
            NSEventType::LeftMouseDown | NSEventType::OtherMouseDown => {
                self.enqueue_sample(event, MacNativeEventKind::MouseDown, None);
            }
            NSEventType::LeftMouseDragged | NSEventType::OtherMouseDragged => {
                self.enqueue_sample(event, MacNativeEventKind::MouseDragged, None);
            }
            NSEventType::LeftMouseUp | NSEventType::OtherMouseUp | NSEventType::MouseCancelled => {
                self.enqueue_sample(event, MacNativeEventKind::MouseUp, Some(0.0));
            }
            NSEventType::TabletPoint => {
                let pressure = normalize_pressure(event.pressure());
                self.enqueue_sample(event, MacNativeEventKind::TabletPoint, Some(pressure));
            }
            _ => {}
        }
    }

    fn enqueue_sample(
        &self,
        event: &NSEvent,
        kind: MacNativeEventKind,
        pressure_override: Option<f32>,
    ) {
        let location = event.locationInWindow();
        let tilt = event.tilt();
        let host_time_us = super::current_time_us();
        let pressure = pressure_override.unwrap_or_else(|| normalize_pressure(event.pressure()));
        let pointer_id = normalize_pointer_id(event.pointingDeviceID() as u64);
        let raw = MacNativeRawSample {
            pointer_id,
            kind,
            in_proximity: self.in_proximity.load(Ordering::Relaxed),
            x_window_px: location.x as f32,
            y_window_px: location.y as f32,
            pressure_0_1: pressure,
            tilt_x_deg: normalize_tilt_component(tilt.x),
            tilt_y_deg: normalize_tilt_component(tilt.y),
            rotation_deg: normalize_rotation_degrees(event.rotation()),
            host_time_us,
            device_time_us: Some(normalize_device_timestamp_us(
                event.timestamp(),
                host_time_us,
            )),
        };

        let sample = self.with_adapter(|adapter| adapter.process_raw_sample(raw));
        if let Some(sample) = sample {
            let _ = self.events.enqueue_sample(sample);
        }
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
    mouse_coalescing_previous: Option<bool>,
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
            mouse_coalescing_previous: None,
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
        let (tx, rx) = mpsc::channel::<Result<(usize, bool), String>>();

        main_window
            .with_webview(move |webview| {
                let result = (|| -> Result<(usize, bool), String> {
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
                            runtime.process_event(event);
                            event_ptr.as_ptr()
                        });

                    let mouse_coalescing_previous = NSEvent::isMouseCoalescingEnabled();
                    NSEvent::setMouseCoalescingEnabled(false);

                    let monitor = unsafe {
                        NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &handler)
                    };
                    let Some(monitor) = monitor else {
                        NSEvent::setMouseCoalescingEnabled(mouse_coalescing_previous);
                        return Err("Failed to register NSEvent local monitor".to_string());
                    };

                    Ok((
                        Retained::into_raw(monitor) as usize,
                        mouse_coalescing_previous,
                    ))
                })();
                let _ = tx.send(result);
            })
            .map_err(|e| format!("Failed to schedule webview monitor install: {e}"))?;

        let (token_raw, mouse_coalescing_previous) = rx
            .recv_timeout(Duration::from_millis(MONITOR_SETUP_TIMEOUT_MS))
            .map_err(|_| "Timed out waiting for macOS monitor installation".to_string())??;

        self.monitor_token_raw = Some(token_raw);
        self.mouse_coalescing_previous = Some(mouse_coalescing_previous);
        tracing::info!(
            "[MacNative] NSEvent mouse coalescing: previous={}, now=false",
            mouse_coalescing_previous
        );
        Ok(())
    }

    fn uninstall_monitor(&mut self) {
        let Some(raw) = self.monitor_token_raw.take() else {
            return;
        };
        let mouse_coalescing_previous = self.mouse_coalescing_previous.take();

        let Some(main_window) = self.app_handle.get_webview_window("main") else {
            unsafe {
                drop(Retained::from_raw(raw as *mut AnyObject));
            }
            if let Some(previous) = mouse_coalescing_previous {
                NSEvent::setMouseCoalescingEnabled(previous);
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
                if let Some(previous) = mouse_coalescing_previous {
                    NSEvent::setMouseCoalescingEnabled(previous);
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
            if let Some(previous) = mouse_coalescing_previous {
                NSEvent::setMouseCoalescingEnabled(previous);
            }
            return;
        }

        match rx.recv_timeout(Duration::from_millis(MONITOR_TEARDOWN_TIMEOUT_MS)) {
            Ok(Err(err)) => {
                tracing::warn!("[MacNative] Failed to remove local monitor: {}", err);
                if let Some(previous) = mouse_coalescing_previous {
                    NSEvent::setMouseCoalescingEnabled(previous);
                }
            }
            Err(_) => {
                tracing::warn!("[MacNative] Timed out waiting for monitor teardown");
                if let Some(previous) = mouse_coalescing_previous {
                    NSEvent::setMouseCoalescingEnabled(previous);
                }
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
        self.runtime.reset_adapter();
        self.runtime.in_proximity.store(false, Ordering::Relaxed);
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
        self.runtime.in_proximity.store(false, Ordering::Relaxed);
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

    fn poll(&mut self, events: &mut Vec<TabletEventV3>) -> usize {
        self.events.drain_into(events, super::current_time_us)
    }

    fn queue_metrics(&self) -> InputQueueMetrics {
        self.events.metrics_snapshot()
    }

    fn v3_diagnostics(&self) -> TabletV3Diagnostics {
        self.runtime.diagnostics_snapshot()
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

    fn poll(&mut self, _events: &mut Vec<TabletEventV3>) -> usize {
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

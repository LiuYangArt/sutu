//! WinTab backend implementation
//!
//! Provides low-latency tablet input on Windows via the WinTab API.
//! This is the preferred backend for Wacom tablets.

use super::backend::{
    default_event_queue_capacity, InputEventQueue, InputQueueMetrics, TabletBackend, TabletConfig,
    TabletEventV3, TabletInfo, TabletStatus,
};
#[cfg(target_os = "windows")]
use super::krita_v3::{CoordinateMapper, WinTabAdapter};
#[cfg(target_os = "windows")]
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[cfg(target_os = "windows")]
use std::thread;
use std::thread::JoinHandle;
#[cfg(target_os = "windows")]
use std::time::Duration;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, POINT, RECT};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::ScreenToClient;
#[cfg(target_os = "windows")]
use windows::Win32::UI::HiDpi::GetDpiForWindow;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetForegroundWindow, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};
#[cfg(target_os = "windows")]
use wintab_lite::{cast_void, Packet, AXIS, CXO, DVC, HCTX, INT, LOGCONTEXT, LPVOID, WTI, WTPKT};

// Function pointer types for WinTab API
#[cfg(target_os = "windows")]
type WTInfoFn = unsafe extern "C" fn(WTI, u32, LPVOID) -> u32;
#[cfg(target_os = "windows")]
type WTOpenFn = unsafe extern "C" fn(HWND, *mut LOGCONTEXT, i32) -> *mut HCTX;
#[cfg(target_os = "windows")]
type WTCloseFn = unsafe extern "C" fn(*mut HCTX) -> i32;
#[cfg(target_os = "windows")]
type WTPacketsGetFn = unsafe extern "C" fn(*mut HCTX, INT, LPVOID) -> INT;
#[cfg(target_os = "windows")]
type WTEnableFn = unsafe extern "C" fn(*mut HCTX, i32) -> i32;
#[cfg(target_os = "windows")]
type WTOverlapFn = unsafe extern "C" fn(*mut HCTX, i32) -> i32;

#[cfg(target_os = "windows")]
const CONTEXT_REENABLE_INTERVAL_LOOPS: u64 = 100;
#[cfg(target_os = "windows")]
static WINTAB_TRACE_ENABLED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
pub fn set_wintab_trace_enabled(enabled: bool) {
    WINTAB_TRACE_ENABLED.store(enabled, Ordering::Relaxed);
    tracing::info!(
        "[WinTabTrace] backend trace {}",
        if enabled { "enabled" } else { "disabled" }
    );
}

#[cfg(not(target_os = "windows"))]
pub fn set_wintab_trace_enabled(_enabled: bool) {}

#[cfg(target_os = "windows")]
pub fn is_wintab_trace_enabled() -> bool {
    WINTAB_TRACE_ENABLED.load(Ordering::Relaxed)
}

#[cfg(not(target_os = "windows"))]
pub fn is_wintab_trace_enabled() -> bool {
    false
}

/// WinTab backend for Windows tablet input
pub struct WinTabBackend {
    status: TabletStatus,
    info: Option<TabletInfo>,
    #[cfg(target_os = "windows")]
    config: TabletConfig,
    running: Arc<AtomicBool>,
    events: Arc<InputEventQueue>,
    poll_thread: Option<JoinHandle<()>>,
    #[cfg(target_os = "windows")]
    pressure_max: f32,
    #[cfg(target_os = "windows")]
    hwnd: Option<isize>, // Window handle for WinTab context
}

impl WinTabBackend {
    /// Create a new WinTab backend
    pub fn new() -> Self {
        Self {
            status: TabletStatus::Disconnected,
            info: None,
            #[cfg(target_os = "windows")]
            config: TabletConfig::default(),
            running: Arc::new(AtomicBool::new(false)),
            events: Arc::new(InputEventQueue::new(
                super::backend::InputBackpressureMode::Lossless,
                default_event_queue_capacity(),
            )),
            poll_thread: None,
            #[cfg(target_os = "windows")]
            pressure_max: 32767.0,
            #[cfg(target_os = "windows")]
            hwnd: None,
        }
    }

    /// Set the window handle for the WinTab context
    #[cfg(target_os = "windows")]
    pub fn set_hwnd(&mut self, hwnd: isize) {
        self.hwnd = Some(hwnd);
    }

    #[cfg(target_os = "windows")]
    #[allow(clippy::type_complexity)]
    fn load_wintab_functions() -> Result<
        (
            libloading::Library,
            WTInfoFn,
            WTOpenFn,
            WTCloseFn,
            WTPacketsGetFn,
            WTEnableFn,
            WTOverlapFn,
        ),
        String,
    > {
        let lib = unsafe { libloading::Library::new("Wintab32.dll") }
            .map_err(|e| format!("Failed to load Wintab32.dll: {}", e))?;

        let wt_info: WTInfoFn = unsafe {
            match lib.get::<WTInfoFn>(b"WTInfoA") {
                Ok(f) => *f,
                Err(e) => return Err(format!("Failed to get WTInfoA: {}", e)),
            }
        };

        let wt_open: WTOpenFn = unsafe {
            match lib.get::<WTOpenFn>(b"WTOpenA") {
                Ok(f) => *f,
                Err(e) => return Err(format!("Failed to get WTOpenA: {}", e)),
            }
        };

        let wt_close: WTCloseFn = unsafe {
            match lib.get::<WTCloseFn>(b"WTClose") {
                Ok(f) => *f,
                Err(e) => return Err(format!("Failed to get WTClose: {}", e)),
            }
        };

        let wt_packets_get: WTPacketsGetFn = unsafe {
            match lib.get::<WTPacketsGetFn>(b"WTPacketsGet") {
                Ok(f) => *f,
                Err(e) => return Err(format!("Failed to get WTPacketsGet: {}", e)),
            }
        };

        let wt_enable: WTEnableFn = unsafe {
            match lib.get::<WTEnableFn>(b"WTEnable") {
                Ok(f) => *f,
                Err(e) => return Err(format!("Failed to get WTEnable: {}", e)),
            }
        };

        let wt_overlap: WTOverlapFn = unsafe {
            match lib.get::<WTOverlapFn>(b"WTOverlap") {
                Ok(f) => *f,
                Err(e) => return Err(format!("Failed to get WTOverlap: {}", e)),
            }
        };

        Ok((
            lib,
            wt_info,
            wt_open,
            wt_close,
            wt_packets_get,
            wt_enable,
            wt_overlap,
        ))
    }

    #[cfg(target_os = "windows")]
    fn query_device_info(wt_info: WTInfoFn) -> Option<(String, (i32, i32), bool)> {
        let mut device_name = wintab_lite::CString40::default();
        let name_result =
            unsafe { wt_info(WTI::DEVICES, DVC::NAME as u32, cast_void!(device_name)) };

        if name_result == 0 {
            return None;
        }

        let mut pressure_axis = AXIS::default();
        let pressure_result = unsafe {
            wt_info(
                WTI::DEVICES,
                DVC::NPRESSURE as u32,
                cast_void!(pressure_axis),
            )
        };

        let pressure_range = if pressure_result > 0 {
            (pressure_axis.axMin, pressure_axis.axMax)
        } else {
            (0, 1024)
        };

        // Tilt support detection: assume true for Wacom devices
        // (DVC::TILTX constant not available in wintab_lite, but most Wacom tablets support it)
        let supports_tilt = true;

        Some((device_name.to_string(), pressure_range, supports_tilt))
    }
}

impl Default for WinTabBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl TabletBackend for WinTabBackend {
    #[cfg(target_os = "windows")]
    fn init(&mut self, config: &TabletConfig) -> Result<(), String> {
        self.config = config.clone();
        self.events = Arc::new(InputEventQueue::new(
            config.backpressure_mode,
            default_event_queue_capacity(),
        ));

        let (lib, wt_info, _wt_open, _wt_close, _wt_packets_get, _wt_enable, _wt_overlap) =
            Self::load_wintab_functions()?;

        // Query device info
        let (name, pressure_range, supports_tilt) =
            Self::query_device_info(wt_info).ok_or_else(|| "No tablet device found".to_string())?;

        self.pressure_max = pressure_range.1 as f32;

        self.info = Some(TabletInfo {
            name,
            backend: "WinTab".to_string(),
            supports_pressure: true,
            supports_tilt,
            pressure_range,
        });

        self.status = TabletStatus::Connected;

        // Keep library loaded
        std::mem::forget(lib);

        tracing::info!("[WinTab] Initialized: {:?}", self.info);
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    fn init(&mut self, _config: &TabletConfig) -> Result<(), String> {
        Err("WinTab is only available on Windows".to_string())
    }

    #[cfg(target_os = "windows")]
    fn start(&mut self) -> Result<(), String> {
        if self.status != TabletStatus::Connected {
            return Err("Backend not initialized".to_string());
        }

        if self.running.load(Ordering::SeqCst) {
            return Ok(()); // Already running
        }

        self.events.reopen();
        self.running.store(true, Ordering::SeqCst);

        let running = self.running.clone();
        let events = self.events.clone();
        let polling_interval_ms = 1000 / self.config.polling_rate_hz as u64;
        let pressure_max = self.pressure_max;
        // Note: pressure_curve is now applied in commands.rs AFTER smoothing
        let hwnd_value = self.hwnd; // Copy the stored HWND

        let handle = thread::spawn(move || {
            // Load WinTab functions in this thread
            let Ok((_lib, wt_info, wt_open, wt_close, wt_packets_get, wt_enable, wt_overlap)) =
                WinTabBackend::load_wintab_functions()
            else {
                tracing::error!("[WinTab] Failed to load functions in poll thread");
                return;
            };

            // Get default context (DEFCONTEXT for digitizer-relative coordinates)
            let mut log_context = LOGCONTEXT::default();
            let ctx_result = unsafe { wt_info(WTI::DEFCONTEXT, 0, cast_void!(log_context)) };
            if ctx_result == 0 {
                tracing::error!("[WinTab] Failed to get default context");
                return;
            }

            // Query tablet axes for coordinate conversion
            let mut tablet_x = AXIS::default();
            let mut tablet_y = AXIS::default();
            unsafe {
                wt_info(WTI::DEVICES, DVC::X as u32, cast_void!(tablet_x));
                wt_info(WTI::DEVICES, DVC::Y as u32, cast_void!(tablet_y));
            }
            tracing::info!(
                "[WinTab] Tablet axes: X({}-{}), Y({}-{})",
                tablet_x.axMin,
                tablet_x.axMax,
                tablet_y.axMin,
                tablet_y.axMax
            );

            // Configure context for our needs
            // CXO::SYSTEM is required for WinTab to receive packet data
            // When Windows Ink is disabled in Wacom driver, this won't interfere
            log_context.lcOptions |= CXO::SYSTEM;
            // CRITICAL: lcPktData MUST be WTPKT::all() to match Packet struct layout
            log_context.lcPktData = WTPKT::all();
            log_context.lcPktMode = WTPKT::empty(); // All fields in absolute mode
            log_context.lcMoveMask =
                WTPKT::X | WTPKT::Y | WTPKT::NORMAL_PRESSURE | WTPKT::ORIENTATION | WTPKT::ROTATION;

            // Flip Y axis (tablet Y is inverted by default)
            let default_y_extent = log_context.lcOutExtXYZ.y;
            log_context.lcOutExtXYZ.y = -default_y_extent;

            // Use provided HWND or get foreground window as fallback
            let hwnd_val = if let Some(h) = hwnd_value {
                HWND(h)
            } else {
                let hwnd = unsafe { GetForegroundWindow() };
                HWND(hwnd.0)
            };
            tracing::info!("[WinTab] Using window handle: {:?}", hwnd_val);

            let context_ptr = unsafe { wt_open(hwnd_val, &mut log_context as *mut LOGCONTEXT, 1) };
            if context_ptr.is_null() {
                tracing::error!("[WinTab] Failed to open context");
                return;
            }

            // Enable the context and bring it to the top of the overlap order
            // This ensures the context receives tablet data even when window loses focus
            unsafe {
                wt_enable(context_ptr, 1);
                wt_overlap(context_ptr, 1);
            }
            tracing::info!("[WinTab] Context enabled and set to top of overlap order");

            tracing::info!(
                "[WinTab] Polling thread started at {}Hz, context opened successfully",
                1000 / polling_interval_ms
            );

            let mut client_rect = RECT::default();
            let (window_width, window_height) =
                if unsafe { GetClientRect(hwnd_val, &mut client_rect) }.is_ok() {
                    let width = (client_rect.right - client_rect.left).max(1) as f32;
                    let height = (client_rect.bottom - client_rect.top).max(1) as f32;
                    (width, height)
                } else {
                    let fallback_width = log_context.lcOutExtXYZ.x.abs().max(1) as f32;
                    let fallback_height = log_context.lcOutExtXYZ.y.abs().max(1) as f32;
                    tracing::warn!(
                        "[WinTab] GetClientRect failed, fallback to context extents {}x{}",
                        fallback_width,
                        fallback_height
                    );
                    (fallback_width, fallback_height)
                };
            tracing::info!(
                "[WinTab] Client extents: {}x{}",
                window_width,
                window_height
            );
            let mut dpi = unsafe { GetDpiForWindow(hwnd_val) };
            if dpi == 0 {
                dpi = 96;
            }
            let mut dpi_scale = (dpi as f32 / 96.0).max(0.25);
            tracing::info!("[WinTab] Window DPI: {}, scale={:.4}", dpi, dpi_scale);

            let context_in_x_min = log_context.lcInOrgXYZ.x;
            let context_in_x_max = context_in_x_min.saturating_add(log_context.lcInExtXYZ.x);
            let context_in_y_min = log_context.lcInOrgXYZ.y;
            let context_in_y_max = context_in_y_min.saturating_add(log_context.lcInExtXYZ.y);

            let has_context_x_range = context_in_x_min != context_in_x_max;
            let has_context_y_range = context_in_y_min != context_in_y_max;
            let (map_x_min, map_x_max) = if has_context_x_range {
                (context_in_x_min, context_in_x_max)
            } else {
                (tablet_x.axMin, tablet_x.axMax)
            };
            let (map_y_min, map_y_max) = if has_context_y_range {
                (context_in_y_min, context_in_y_max)
            } else {
                (tablet_y.axMin, tablet_y.axMax)
            };

            let virtual_left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
            let virtual_top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
            let virtual_width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }.max(1) as f32;
            let virtual_height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }.max(1) as f32;
            tracing::info!(
                "[WinTab] Virtual screen: origin=({}, {}), size={}x{}",
                virtual_left,
                virtual_top,
                virtual_width,
                virtual_height
            );

            let mapper = CoordinateMapper::with_axis_range(
                virtual_width,
                virtual_height,
                map_x_min,
                map_x_max,
                map_y_min,
                map_y_max,
                false,
            );
            tracing::info!(
                "[WinTab] Context map in_org=({}, {}), in_ext=({}, {}), out_org=({}, {}), out_ext=({}, {})",
                log_context.lcInOrgXYZ.x,
                log_context.lcInOrgXYZ.y,
                log_context.lcInExtXYZ.x,
                log_context.lcInExtXYZ.y,
                log_context.lcOutOrgXYZ.x,
                log_context.lcOutOrgXYZ.y,
                log_context.lcOutExtXYZ.x,
                log_context.lcOutExtXYZ.y
            );
            tracing::info!(
                "[WinTab] Coordinate mapping range: x=[{}..{}], y=[{}..{}], source={}",
                map_x_min,
                map_x_max,
                map_y_min,
                map_y_max,
                if has_context_x_range && has_context_y_range {
                    "context_input"
                } else {
                    "device_axis_fallback"
                }
            );
            let mut adapters: HashMap<u32, WinTabAdapter> = HashMap::new();

            let mut was_in_proximity = false;
            let mut loop_count: u64 = 0;

            while running.load(Ordering::SeqCst) {
                loop_count += 1;
                if loop_count % 20 == 0 {
                    let current_dpi = unsafe { GetDpiForWindow(hwnd_val) };
                    if current_dpi != 0 {
                        dpi = current_dpi;
                        dpi_scale = (dpi as f32 / 96.0).max(0.25);
                    }
                }

                // Periodically re-enable context to prevent it from being disabled
                // This is a workaround for WinTab context being disabled by other apps
                if loop_count % CONTEXT_REENABLE_INTERVAL_LOOPS == 0 {
                    unsafe {
                        wt_enable(context_ptr, 1);
                        wt_overlap(context_ptr, 1);
                    }
                }

                // Get packets from queue using WTPacketsGet
                const MAX_PACKETS: i32 = 64;
                let mut packets: [Packet; MAX_PACKETS as usize] =
                    core::array::from_fn(|_| Packet::default());

                let count = unsafe {
                    wt_packets_get(
                        context_ptr,
                        MAX_PACKETS,
                        packets.as_mut_ptr() as *mut c_void,
                    )
                };

                if count > 0 {
                    for packet in packets.iter().take(count as usize) {
                        // Check proximity from pkStatus (TPS::PROXIMITY = 0x01)
                        let proximity_bit = packet.pkStatus.bits() & 0x01 != 0;
                        let contact_bit = packet.pkButtons.0 & 0x01 != 0;
                        let in_proximity =
                            proximity_bit || contact_bit || packet.pkNormalPressure > 0;

                        if in_proximity && !was_in_proximity {
                            let _ = events.enqueue_event(TabletEventV3::ProximityEnter);
                        } else if !in_proximity && was_in_proximity {
                            let _ = events.enqueue_event(TabletEventV3::ProximityLeave);
                        }
                        was_in_proximity = in_proximity;
                        let pointer_id = packet.pkCursor;
                        let adapter = adapters.entry(pointer_id).or_insert_with(|| {
                            WinTabAdapter::new(
                                pointer_id,
                                format!("wintab_cursor_{}", pointer_id),
                                pressure_max,
                                mapper,
                            )
                        });
                        if let Some(mut sample) =
                            adapter.convert_packet(packet, super::current_time_us())
                        {
                            let screen_x = sample.x_px + virtual_left as f32;
                            let screen_y = sample.y_px + virtual_top as f32;
                            let mut client_point = POINT {
                                x: screen_x.round() as i32,
                                y: screen_y.round() as i32,
                            };
                            if unsafe { ScreenToClient(hwnd_val, &mut client_point) }.as_bool() {
                                sample.x_px = client_point.x as f32 / dpi_scale;
                                sample.y_px = client_point.y as f32 / dpi_scale;
                            } else {
                                // Fallback: best-effort clamp into current client extents.
                                sample.x_px =
                                    (sample.x_px / dpi_scale).clamp(0.0, window_width / dpi_scale);
                                sample.y_px =
                                    (sample.y_px / dpi_scale).clamp(0.0, window_height / dpi_scale);
                            }

                            if is_wintab_trace_enabled() {
                                tracing::info!(
                                    "[WinTabTrace][Rust][packet] host_time_us={} device_time_us={} pointer_id={} stroke_id={} phase={:?} raw_x={} raw_y={} screen_x_px={:.2} screen_y_px={:.2} mapped_x_px={:.2} mapped_y_px={:.2} dpi={} dpi_scale={:.4} raw_pressure={} pressure_0_1={:.4} buttons=0x{:x} status_bits=0x{:x}",
                                    sample.host_time_us,
                                    sample.device_time_us.unwrap_or(sample.host_time_us),
                                    sample.pointer_id,
                                    sample.stroke_id,
                                    sample.phase,
                                    packet.pkXYZ.x,
                                    packet.pkXYZ.y,
                                    screen_x,
                                    screen_y,
                                    sample.x_px,
                                    sample.y_px,
                                    dpi,
                                    dpi_scale,
                                    packet.pkNormalPressure,
                                    sample.pressure_0_1,
                                    packet.pkButtons.0,
                                    packet.pkStatus.bits()
                                );
                            }
                            let _ = events.enqueue_sample(sample);
                        }
                    }
                }

                thread::sleep(Duration::from_millis(polling_interval_ms));
            }

            // Cleanup
            unsafe {
                wt_close(context_ptr);
            }
            tracing::info!("[WinTab] Polling thread stopped");
        });

        self.poll_thread = Some(handle);
        tracing::info!("[WinTab] Started");
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    fn start(&mut self) -> Result<(), String> {
        Err("WinTab is only available on Windows".to_string())
    }

    fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        self.events.close();

        if let Some(handle) = self.poll_thread.take() {
            let _ = handle.join();
        }
        self.events.clear();

        tracing::info!("[WinTab] Stopped");
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

    #[cfg(target_os = "windows")]
    fn is_available() -> bool {
        unsafe { libloading::Library::new("Wintab32.dll") }.is_ok()
    }

    #[cfg(not(target_os = "windows"))]
    fn is_available() -> bool {
        false
    }

    fn name(&self) -> &'static str {
        "WinTab"
    }
}

impl Drop for WinTabBackend {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wintab_backend_creation() {
        let backend = WinTabBackend::new();
        assert_eq!(backend.status(), TabletStatus::Disconnected);
        assert!(backend.info().is_none());
    }
}

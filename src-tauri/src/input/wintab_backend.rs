//! WinTab backend implementation
//!
//! Provides low-latency tablet input on Windows via the WinTab API.
//! This is the preferred backend for Wacom tablets.

use super::backend::{
    default_event_queue_capacity, InputEventQueue, InputQueueMetrics, TabletBackend, TabletConfig,
    TabletEventV2, TabletInfo, TabletStatus,
};
#[cfg(target_os = "windows")]
use super::backend::{InputPhase, InputSampleV2, InputSource};
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
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
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
const WINTAB_ANGLE_TENTHS_PER_DEGREE: f32 = 10.0;
#[cfg(target_os = "windows")]
const CONTEXT_REENABLE_INTERVAL_LOOPS: u64 = 100;

#[cfg(target_os = "windows")]
fn normalize_rotation_degrees(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.rem_euclid(360.0)
}

/// Convert WinTab orientation (azimuth/altitude in 0.1 degree units) into
/// PointerEvent-compatible tilt angles (degrees, -90..90).
#[cfg(target_os = "windows")]
fn orientation_to_tilt_degrees(azimuth_tenths: i32, altitude_tenths: i32) -> (f32, f32) {
    let azimuth_rad = (azimuth_tenths as f32 / WINTAB_ANGLE_TENTHS_PER_DEGREE).to_radians();
    let altitude_rad = (altitude_tenths as f32 / WINTAB_ANGLE_TENTHS_PER_DEGREE).to_radians();

    // Pen axis in tablet coordinates.
    let axis_xy = altitude_rad.cos();
    let axis_z = altitude_rad.sin();
    let axis_x = azimuth_rad.cos() * axis_xy;
    let axis_y = azimuth_rad.sin() * axis_xy;

    let tilt_x = axis_x.atan2(axis_z).to_degrees().clamp(-90.0, 90.0);
    let tilt_y = axis_y.atan2(axis_z).to_degrees().clamp(-90.0, 90.0);
    (tilt_x, tilt_y)
}

#[cfg(target_os = "windows")]
fn packet_rotation_degrees(packet: &Packet) -> f32 {
    // WinTab Orientation::orTwist is typically reported in 0.1 degree units.
    // Keep a normalized 0..360 range to match PointerEvent.twist semantics.
    normalize_rotation_degrees(packet.pkOrientation.orTwist as f32 / WINTAB_ANGLE_TENTHS_PER_DEGREE)
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
    stream_id: u64,
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
            stream_id: 1,
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
        let stream_id = self.stream_id;
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

            let screen_width = log_context.lcOutExtXYZ.x.abs() as f32;
            let screen_height = log_context.lcOutExtXYZ.y.abs() as f32;
            tracing::info!(
                "[WinTab] Output extents: {}x{}",
                screen_width,
                screen_height
            );

            let mut was_in_proximity = false;
            let mut loop_count: u64 = 0;

            while running.load(Ordering::SeqCst) {
                loop_count += 1;

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
                        let in_proximity = proximity_bit || packet.pkNormalPressure > 0;

                        if in_proximity && !was_in_proximity {
                            let _ = events.enqueue_event(TabletEventV2::ProximityEnter);
                        } else if !in_proximity && was_in_proximity {
                            let _ = events.enqueue_event(TabletEventV2::ProximityLeave);
                        }
                        was_in_proximity = in_proximity;

                        // Convert to normalized pressure (raw value, curve applied later after smoothing)
                        let pressure = packet.pkNormalPressure as f32 / pressure_max;

                        // Convert tablet coordinates to screen coordinates
                        // pkXYZ contains output coordinates (already scaled by context)
                        let x = packet.pkXYZ.x as f32;
                        let y = packet.pkXYZ.y as f32;

                        let (tilt_x, tilt_y) = orientation_to_tilt_degrees(
                            packet.pkOrientation.orAzimuth,
                            packet.pkOrientation.orAltitude,
                        );
                        let rotation = packet_rotation_degrees(packet);

                        let host_time_us = super::current_time_us();
                        let device_time_us = (packet.pkTime as u64).saturating_mul(1000);
                        let sample = InputSampleV2 {
                            seq: 0,
                            stream_id,
                            source: InputSource::WinTab,
                            pointer_id: 0,
                            phase: if pressure > 0.0 {
                                InputPhase::Move
                            } else {
                                InputPhase::Hover
                            },
                            x,
                            y,
                            pressure,
                            tilt_x,
                            tilt_y,
                            rotation,
                            host_time_us,
                            device_time_us,
                            timestamp_ms: host_time_us / 1000,
                        };
                        let _ = events.enqueue_sample(sample);
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

    fn poll(&mut self, events: &mut Vec<TabletEventV2>) -> usize {
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

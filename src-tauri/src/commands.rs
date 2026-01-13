//! Tauri commands - IPC interface between frontend and backend

use crate::brush::{BrushEngine, StrokeSegment};
use crate::input::wintab_spike::SpikeResult;
use crate::input::{
    PressureCurve, PressureSmoother, RawInputPoint, TabletBackend, TabletConfig, TabletEvent,
    TabletInfo, TabletStatus,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

/// Document information returned after creation
#[derive(Debug, Clone, Serialize)]
pub struct DocumentInfo {
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    pub id: String,
}

/// System information for diagnostics
#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    pub platform: String,
    pub arch: String,
    pub tablet_connected: bool,
    pub tablet_name: Option<String>,
}

/// Create a new document
#[tauri::command]
pub async fn create_document(width: u32, height: u32, dpi: u32) -> Result<DocumentInfo, String> {
    tracing::info!("Creating document: {}x{} @ {}dpi", width, height, dpi);

    // Validate dimensions
    if width == 0 || height == 0 {
        return Err("Document dimensions must be greater than 0".into());
    }

    if width > 16384 || height > 16384 {
        return Err("Document dimensions cannot exceed 16384 pixels".into());
    }

    let id = format!("doc_{}", uuid_simple());

    Ok(DocumentInfo {
        width,
        height,
        dpi,
        id,
    })
}

/// Get system information
#[tauri::command]
pub fn get_system_info() -> SystemInfo {
    SystemInfo {
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        tablet_connected: false, // TODO: Implement tablet detection
        tablet_name: None,
    }
}

/// Process a stroke from raw input points
#[tauri::command]
pub fn process_stroke(points: Vec<RawInputPoint>) -> Result<Vec<StrokeSegment>, String> {
    if points.is_empty() {
        return Ok(vec![]);
    }

    let engine = BrushEngine::default();
    let segments = engine.process(&points);

    Ok(segments)
}

/// Generate a simple UUID-like string
fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();

    format!("{:x}{:x}", now.as_secs(), now.subsec_nanos())
}

/// Run WinTab spike test to verify tablet integration
#[tauri::command]
pub fn run_wintab_spike(hwnd: Option<isize>) -> SpikeResult {
    use crate::input::wintab_spike::spike;

    tracing::info!("Running WinTab spike test...");
    spike::run_wintab_spike(hwnd.unwrap_or(0))
}

/// Check if WinTab is available
#[tauri::command]
pub fn check_wintab_available() -> bool {
    use crate::input::wintab_spike::spike;

    spike::check_wintab_available()
}

// ============================================================================
// Tablet Input System
// ============================================================================

/// Global tablet manager state
static TABLET_STATE: OnceLock<Arc<Mutex<TabletState>>> = OnceLock::new();

/// Backend type enum for serialization
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendType {
    WinTab,
    PointerEvent,
    Auto,
}

/// Tablet state holding the active backend
struct TabletState {
    backend_type: BackendType,
    wintab: Option<crate::input::WinTabBackend>,
    pointer: Option<crate::input::PointerEventBackend>,
    config: TabletConfig,
    app_handle: Option<AppHandle>,
    emitter_running: bool,
    /// Pressure smoother for first-stroke issue (shared with emitter thread)
    pressure_smoother: Arc<Mutex<PressureSmoother>>,
    /// Track if pen is currently drawing (pressure > 0)
    is_drawing: Arc<std::sync::atomic::AtomicBool>,
    /// Pressure curve for mapping (applied after smoothing)
    pressure_curve: Arc<std::sync::atomic::AtomicU8>,
    /// Stroke logger for debugging (shared with emitter thread)
    stroke_log: Arc<Mutex<StrokeLog>>,
}

/// Stroke log entry for debugging pressure issues
#[derive(Debug, Clone)]
struct StrokeLogEntry {
    sample: usize,
    x: f32,
    y: f32,
    raw_pressure: f32,
    smoothed: f32,
    curved: f32,
    timestamp_ms: u64,
}

/// Collects stroke data for debugging
#[derive(Debug, Default)]
struct StrokeLog {
    entries: Vec<StrokeLogEntry>,
    stroke_count: usize,
    enabled: bool,
}

impl StrokeLog {
    fn new() -> Self {
        Self {
            entries: Vec::with_capacity(256),
            stroke_count: 0,
            enabled: true, // Enable by default for debugging
        }
    }

    fn add_entry(&mut self, entry: StrokeLogEntry) {
        if self.enabled {
            self.entries.push(entry);
        }
    }

    fn end_stroke(&mut self) {
        if !self.enabled || self.entries.is_empty() {
            return;
        }

        self.stroke_count += 1;

        // Write to file
        let log_path =
            std::env::temp_dir().join(format!("paintboard_stroke_{}.csv", self.stroke_count));

        if let Ok(mut file) = std::fs::File::create(&log_path) {
            use std::io::Write;
            // Header
            let _ = writeln!(file, "sample,x,y,raw_pressure,smoothed,curved,timestamp_ms");
            // Data
            for entry in &self.entries {
                let _ = writeln!(
                    file,
                    "{},{:.2},{:.2},{:.4},{:.4},{:.4},{}",
                    entry.sample,
                    entry.x,
                    entry.y,
                    entry.raw_pressure,
                    entry.smoothed,
                    entry.curved,
                    entry.timestamp_ms
                );
            }
            tracing::info!(
                "[StrokeLog] Wrote stroke #{} to {:?} ({} points)",
                self.stroke_count,
                log_path,
                self.entries.len()
            );
        }

        self.entries.clear();
    }
}

impl TabletState {
    fn new() -> Self {
        Self {
            backend_type: BackendType::Auto,
            wintab: None,
            pointer: None,
            config: TabletConfig::default(),
            app_handle: None,
            emitter_running: false,
            pressure_smoother: Arc::new(Mutex::new(PressureSmoother::new(3))),
            is_drawing: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            pressure_curve: Arc::new(std::sync::atomic::AtomicU8::new(0)), // 0=Linear
            stroke_log: Arc::new(Mutex::new(StrokeLog::new())),
        }
    }

    fn active_backend(&mut self) -> Option<&mut dyn TabletBackend> {
        match self.backend_type {
            BackendType::WinTab => self.wintab.as_mut().map(|b| b as &mut dyn TabletBackend),
            BackendType::PointerEvent => self.pointer.as_mut().map(|b| b as &mut dyn TabletBackend),
            BackendType::Auto => {
                // Prefer WinTab if available
                if self.wintab.is_some() {
                    self.wintab.as_mut().map(|b| b as &mut dyn TabletBackend)
                } else {
                    self.pointer.as_mut().map(|b| b as &mut dyn TabletBackend)
                }
            }
        }
    }
}

fn get_tablet_state() -> Arc<Mutex<TabletState>> {
    TABLET_STATE
        .get_or_init(|| Arc::new(Mutex::new(TabletState::new())))
        .clone()
}

/// Tablet status response for frontend
#[derive(Debug, Clone, Serialize)]
pub struct TabletStatusResponse {
    pub status: TabletStatus,
    pub backend: String,
    pub info: Option<TabletInfo>,
}

/// Initialize tablet input system
#[tauri::command]
pub fn init_tablet(
    app: AppHandle,
    backend: Option<BackendType>,
    polling_rate: Option<u32>,
    pressure_curve: Option<String>,
) -> Result<TabletStatusResponse, String> {
    let state = get_tablet_state();
    let mut state = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    // Store app handle for event emission
    state.app_handle = Some(app.clone());

    // If already initialized with a working backend, return current status (idempotent)
    if state.wintab.is_some() || state.pointer.is_some() {
        tracing::info!("[Tablet] Already initialized, returning current status");
        let (status, backend_name, info) = if let Some(b) = state.active_backend() {
            (b.status(), b.name().to_string(), b.info().cloned())
        } else {
            (TabletStatus::Disconnected, "none".to_string(), None)
        };
        return Ok(TabletStatusResponse {
            status,
            backend: backend_name,
            info,
        });
    }

    // Get HWND from main window (Windows only)
    #[cfg(target_os = "windows")]
    let main_hwnd: Option<isize> = {
        if let Some(window) = app.get_webview_window("main") {
            match window.window_handle() {
                Ok(handle) => match handle.as_raw() {
                    RawWindowHandle::Win32(win32_handle) => {
                        let hwnd = win32_handle.hwnd.get();
                        tracing::info!("[Tablet] Got main window HWND: {}", hwnd);
                        Some(hwnd)
                    }
                    _ => {
                        tracing::warn!("[Tablet] Not a Win32 window handle");
                        None
                    }
                },
                Err(e) => {
                    tracing::warn!("[Tablet] Failed to get window handle: {:?}", e);
                    None
                }
            }
        } else {
            tracing::warn!("[Tablet] Main window not found");
            None
        }
    };

    // Configure
    state.config.polling_rate_hz = polling_rate.unwrap_or(200);
    let curve = match pressure_curve.as_deref() {
        Some("soft") => PressureCurve::Soft,
        Some("hard") => PressureCurve::Hard,
        Some("scurve") => PressureCurve::SCurve,
        _ => PressureCurve::Linear,
    };
    state.config.pressure_curve = curve;
    // Store curve type as atomic for thread-safe access (0=Linear, 1=Soft, 2=Hard, 3=SCurve)
    let curve_id = match curve {
        PressureCurve::Linear => 0u8,
        PressureCurve::Soft => 1u8,
        PressureCurve::Hard => 2u8,
        PressureCurve::SCurve => 3u8,
    };
    state
        .pressure_curve
        .store(curve_id, std::sync::atomic::Ordering::Relaxed);

    let requested_backend = backend.unwrap_or(BackendType::Auto);
    state.backend_type = requested_backend;

    // Try WinTab first if requested or auto
    if matches!(requested_backend, BackendType::WinTab | BackendType::Auto) {
        let mut wintab = crate::input::WinTabBackend::new();

        // Set HWND before init (Windows only)
        #[cfg(target_os = "windows")]
        if let Some(hwnd) = main_hwnd {
            wintab.set_hwnd(hwnd);
        }

        if wintab.init(&state.config).is_ok() {
            state.wintab = Some(wintab);
            state.backend_type = BackendType::WinTab;
            tracing::info!("[Tablet] Initialized WinTab backend");
        }
    }

    // Fall back to PointerEvent if WinTab not available or specifically requested
    if state.wintab.is_none() || matches!(requested_backend, BackendType::PointerEvent) {
        let mut pointer = crate::input::PointerEventBackend::new();
        if pointer.init(&state.config).is_ok() {
            state.pointer = Some(pointer);
            if state.wintab.is_none() {
                state.backend_type = BackendType::PointerEvent;
            }
            tracing::info!("[Tablet] Initialized PointerEvent backend");
        }
    }

    // Get status from active backend
    let (status, backend_name, info) = if let Some(backend) = state.active_backend() {
        (
            backend.status(),
            backend.name().to_string(),
            backend.info().cloned(),
        )
    } else {
        return Err("No tablet backend available".to_string());
    };

    Ok(TabletStatusResponse {
        status,
        backend: backend_name,
        info,
    })
}

/// Start tablet input streaming
#[tauri::command]
pub fn start_tablet() -> Result<(), String> {
    let state = get_tablet_state();
    let mut state = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    if let Some(backend) = state.active_backend() {
        backend.start()?;
    }

    // Start event emitter thread if not running
    if !state.emitter_running {
        if let Some(app) = state.app_handle.clone() {
            state.emitter_running = true;
            let state_clone = get_tablet_state();
            // Clone Arc handles for the emitter thread
            let pressure_smoother = state.pressure_smoother.clone();
            let is_drawing = state.is_drawing.clone();
            let stroke_log = state.stroke_log.clone();

            std::thread::spawn(move || {
                tracing::info!("[Tablet] Event emitter thread started");
                let mut events = Vec::with_capacity(64);
                let mut events_to_emit = Vec::with_capacity(64);

                loop {
                    // Step 1: Quickly poll events while holding the lock (minimize lock time)
                    let should_continue = {
                        let Ok(mut state) = state_clone.try_lock() else {
                            // Lock is held by another thread, skip this iteration
                            std::thread::sleep(std::time::Duration::from_millis(1));
                            continue;
                        };

                        if !state.emitter_running {
                            break;
                        }

                        if let Some(backend) = state.active_backend() {
                            backend.poll(&mut events);
                        }
                        true
                    };
                    // Lock is released here

                    if !should_continue {
                        break;
                    }

                    // Step 2: Process and emit events OUTSIDE the lock
                    if !events.is_empty() {
                        // Process events with pressure smoothing
                        for event in events.drain(..) {
                            let processed_event = match event {
                                TabletEvent::Input(mut point) => {
                                    let was_drawing =
                                        is_drawing.load(std::sync::atomic::Ordering::Relaxed);
                                    let now_drawing = point.pressure > 0.0;

                                    // Reset smoother when stroke starts (pressure goes from 0 to >0)
                                    if now_drawing && !was_drawing {
                                        if let Ok(mut smoother) = pressure_smoother.lock() {
                                            smoother.reset();
                                        }
                                    }

                                    // End stroke log when pen lifts (was drawing, now not)
                                    if was_drawing && !now_drawing {
                                        if let Ok(mut log) = stroke_log.lock() {
                                            log.end_stroke();
                                        }
                                    }

                                    // Apply pressure smoothing when drawing
                                    // Note: Pressure curve is applied in frontend, not here
                                    if now_drawing {
                                        if let Ok(mut smoother) = pressure_smoother.lock() {
                                            // Log raw pressure for debugging
                                            let raw_pressure = point.pressure;
                                            // Smooth raw pressure (curve is applied in frontend)
                                            let smoothed = smoother.smooth(point.pressure);
                                            point.pressure = smoothed;

                                            // Add to stroke log
                                            if let Ok(mut log) = stroke_log.lock() {
                                                log.add_entry(StrokeLogEntry {
                                                    sample: smoother.sample_count(),
                                                    x: point.x,
                                                    y: point.y,
                                                    raw_pressure,
                                                    smoothed,
                                                    curved: smoothed, // No curve applied here
                                                    timestamp_ms: point.timestamp_ms,
                                                });
                                            }

                                            // Debug log for first few samples of each stroke
                                            if smoother.sample_count() <= 5 {
                                                tracing::info!(
                                                    "[Pressure] sample={} raw={:.3} smoothed={:.3}",
                                                    smoother.sample_count(),
                                                    raw_pressure,
                                                    smoothed,
                                                );
                                            }
                                        }
                                    }

                                    is_drawing
                                        .store(now_drawing, std::sync::atomic::Ordering::Relaxed);
                                    TabletEvent::Input(point)
                                }
                                TabletEvent::ProximityLeave => {
                                    // End stroke log and reset smoother when pen leaves
                                    if let Ok(mut log) = stroke_log.lock() {
                                        log.end_stroke();
                                    }
                                    is_drawing.store(false, std::sync::atomic::Ordering::Relaxed);
                                    if let Ok(mut smoother) = pressure_smoother.lock() {
                                        smoother.reset();
                                    }
                                    TabletEvent::ProximityLeave
                                }
                                other => other,
                            };
                            events_to_emit.push(processed_event);
                        }

                        // Emit processed events
                        for event in events_to_emit.drain(..) {
                            if let Err(e) = app.emit("tablet-event", &event) {
                                tracing::error!("[Tablet] Failed to emit event: {}", e);
                            }
                        }
                    }

                    std::thread::sleep(std::time::Duration::from_millis(2));
                }

                tracing::info!("[Tablet] Event emitter thread stopped");
            });
        }
    }

    Ok(())
}

/// Stop tablet input streaming
#[tauri::command]
pub fn stop_tablet() -> Result<(), String> {
    let state = get_tablet_state();
    let mut state = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    state.emitter_running = false;

    if let Some(backend) = state.active_backend() {
        backend.stop();
    }

    Ok(())
}

/// Get current tablet status
#[tauri::command]
pub fn get_tablet_status() -> Result<TabletStatusResponse, String> {
    let state = get_tablet_state();
    let mut state = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    if let Some(backend) = state.active_backend() {
        Ok(TabletStatusResponse {
            status: backend.status(),
            backend: backend.name().to_string(),
            info: backend.info().cloned(),
        })
    } else {
        Ok(TabletStatusResponse {
            status: TabletStatus::Disconnected,
            backend: "none".to_string(),
            info: None,
        })
    }
}

/// Push pointer event from frontend (for PointerEvent backend)
#[tauri::command]
pub fn push_pointer_event(
    x: f32,
    y: f32,
    pressure: f32,
    tilt_x: f32,
    tilt_y: f32,
) -> Result<(), String> {
    let state = get_tablet_state();
    let state = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    if let Some(pointer) = &state.pointer {
        pointer.push_input(x, y, pressure, tilt_x, tilt_y);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_create_document() {
        let result = create_document(1920, 1080, 72).await;
        assert!(result.is_ok());

        let Ok(doc) = result else {
            panic!("create_document should succeed");
        };
        assert_eq!(doc.width, 1920);
        assert_eq!(doc.height, 1080);
        assert_eq!(doc.dpi, 72);
    }

    #[tokio::test]
    async fn test_create_document_invalid_dimensions() {
        let result = create_document(0, 1080, 72).await;
        assert!(result.is_err());

        let result = create_document(20000, 1080, 72).await;
        assert!(result.is_err());
    }

    #[test]
    fn test_get_system_info() {
        let info = get_system_info();
        assert!(!info.platform.is_empty());
        assert!(!info.arch.is_empty());
    }
}

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

                                    // Apply pressure smoothing when drawing
                                    // Note: Pressure curve is applied in frontend, not here
                                    if now_drawing {
                                        if let Ok(mut smoother) = pressure_smoother.lock() {
                                            if !was_drawing {
                                                smoother.reset();
                                            }
                                            point.pressure = smoother.smooth(point.pressure);
                                        }
                                    }

                                    is_drawing
                                        .store(now_drawing, std::sync::atomic::Ordering::Relaxed);
                                    TabletEvent::Input(point)
                                }
                                TabletEvent::ProximityLeave => {
                                    // Reset smoother when pen leaves
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

// ============================================================================
// Soft Brush SIMD Rendering
// ============================================================================

use crate::brush::soft_dab::{render_soft_dab, GaussParams};

/// Dirty rectangle from soft dab rendering
pub type SoftDabResult = (Vec<u8>, (usize, usize, usize, usize));

/// Stamp a soft brush dab using SIMD-optimized Gaussian mask
///
/// This command offloads the heavy mask calculation to Rust with SIMD acceleration.
/// Returns the modified buffer and dirty rectangle.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn stamp_soft_dab(
    buffer: Vec<u8>,
    buffer_width: usize,
    buffer_height: usize,
    cx: f32,
    cy: f32,
    radius: f32,
    hardness: f32,
    roundness: f32,
    color: (u8, u8, u8),
    flow: f32,
    dab_opacity: f32,
) -> Result<SoftDabResult, String> {
    // Validate buffer size
    let expected_size = buffer_width * buffer_height * 4;
    if buffer.len() != expected_size {
        return Err(format!(
            "Buffer size mismatch: expected {}, got {}",
            expected_size,
            buffer.len()
        ));
    }

    let mut buffer = buffer;
    let params = GaussParams::new(hardness, radius, roundness);

    let dirty_rect = render_soft_dab(
        &mut buffer,
        buffer_width,
        buffer_height,
        cx,
        cy,
        radius,
        &params,
        color,
        flow,
        dab_opacity,
    );

    Ok((buffer, dirty_rect))
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

//! Tauri commands - IPC interface between frontend and backend

use crate::brush::{BrushEngine, StrokeSegment};
use crate::input::wintab_spike::SpikeResult;
use crate::input::{
    InputBackpressureMode, InputPhase, InputQueueMetrics, PressureCurve, RawInputPoint,
    TabletBackend, TabletConfig, TabletInfo, TabletStatus,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
#[cfg(target_os = "windows")]
use tauri::Manager;

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
    MacNative,
    PointerEvent,
}

/// Tablet state holding the active backend
struct TabletState {
    requested_backend: BackendType,
    backend_type: BackendType,
    wintab: Option<crate::input::WinTabBackend>,
    macnative: Option<crate::input::MacNativeBackend>,
    pointer: Option<crate::input::PointerEventBackend>,
    config: TabletConfig,
    app_handle: Option<AppHandle>,
    emitter_running: bool,
}

impl TabletState {
    fn new() -> Self {
        let default_backend = default_backend_for_platform();
        Self {
            requested_backend: default_backend,
            backend_type: default_backend,
            wintab: None,
            macnative: None,
            pointer: None,
            config: TabletConfig::default(),
            app_handle: None,
            emitter_running: false,
        }
    }

    fn active_backend(&mut self) -> Option<&mut dyn TabletBackend> {
        match self.backend_type {
            BackendType::WinTab => self.wintab.as_mut().map(|b| b as &mut dyn TabletBackend),
            BackendType::MacNative => self.macnative.as_mut().map(|b| b as &mut dyn TabletBackend),
            BackendType::PointerEvent => self.pointer.as_mut().map(|b| b as &mut dyn TabletBackend),
        }
    }
}

fn get_tablet_state() -> Arc<Mutex<TabletState>> {
    TABLET_STATE
        .get_or_init(|| Arc::new(Mutex::new(TabletState::new())))
        .clone()
}

fn parse_pressure_curve(curve: Option<&str>) -> PressureCurve {
    match curve {
        Some("soft") => PressureCurve::Soft,
        Some("hard") => PressureCurve::Hard,
        Some("scurve") => PressureCurve::SCurve,
        _ => PressureCurve::Linear,
    }
}

fn parse_backpressure_mode(mode: Option<&str>) -> InputBackpressureMode {
    match mode {
        Some("latency_capped") => InputBackpressureMode::LatencyCapped,
        _ => InputBackpressureMode::Lossless,
    }
}

fn backend_type_name(backend: BackendType) -> &'static str {
    match backend {
        BackendType::WinTab => "wintab",
        BackendType::MacNative => "macnative",
        BackendType::PointerEvent => "pointerevent",
    }
}

fn default_backend_for_platform() -> BackendType {
    #[cfg(target_os = "windows")]
    {
        BackendType::WinTab
    }
    #[cfg(target_os = "macos")]
    {
        BackendType::MacNative
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        BackendType::PointerEvent
    }
}

fn normalize_requested_backend_for_platform(requested_backend: BackendType) -> BackendType {
    #[cfg(target_os = "windows")]
    {
        match requested_backend {
            BackendType::MacNative => BackendType::WinTab,
            other => other,
        }
    }
    #[cfg(target_os = "macos")]
    {
        match requested_backend {
            BackendType::WinTab => BackendType::MacNative,
            other => other,
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = requested_backend;
        BackendType::PointerEvent
    }
}

fn apply_tablet_runtime_config(
    state: &mut TabletState,
    polling_rate: Option<u32>,
    pressure_curve: Option<&str>,
    backpressure_mode: Option<&str>,
) {
    if let Some(rate) = polling_rate {
        state.config.polling_rate_hz = rate;
    }
    state.config.pressure_curve = parse_pressure_curve(pressure_curve);
    state.config.backpressure_mode = parse_backpressure_mode(backpressure_mode);
}

fn current_tablet_status_response(state: &mut TabletState) -> TabletStatusResponse {
    let requested_backend = backend_type_name(state.requested_backend).to_string();
    let backpressure_mode = state.config.backpressure_mode;

    if let Some(backend) = state.active_backend() {
        let backend_name = backend.name().to_string();
        let status = backend.status();
        let info = backend.info().cloned();
        let queue_metrics = backend.queue_metrics();
        TabletStatusResponse {
            status,
            backend: backend_name,
            requested_backend,
            active_backend: backend_type_name(state.backend_type).to_string(),
            backpressure_mode,
            queue_metrics,
            info,
        }
    } else {
        TabletStatusResponse {
            status: TabletStatus::Disconnected,
            backend: "none".to_string(),
            requested_backend,
            active_backend: "none".to_string(),
            backpressure_mode,
            queue_metrics: InputQueueMetrics::default(),
            info: None,
        }
    }
}

#[cfg(target_os = "windows")]
fn resolve_main_hwnd(app: &AppHandle) -> Option<isize> {
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
}

#[cfg(not(target_os = "windows"))]
fn resolve_main_hwnd(_app: &AppHandle) -> Option<isize> {
    None
}

fn build_wintab_backend(
    config: &TabletConfig,
    main_hwnd: Option<isize>,
) -> Result<crate::input::WinTabBackend, String> {
    #[cfg(not(target_os = "windows"))]
    let _ = main_hwnd;

    let mut wintab = crate::input::WinTabBackend::new();
    #[cfg(target_os = "windows")]
    if let Some(hwnd) = main_hwnd {
        wintab.set_hwnd(hwnd);
    }
    wintab.init(config)?;
    Ok(wintab)
}

fn build_pointer_backend(
    config: &TabletConfig,
) -> Result<crate::input::PointerEventBackend, String> {
    let mut pointer = crate::input::PointerEventBackend::new();
    pointer.init(config)?;
    Ok(pointer)
}

fn build_mac_native_backend(
    config: &TabletConfig,
    app_handle: &AppHandle,
) -> Result<crate::input::MacNativeBackend, String> {
    let mut macnative = crate::input::MacNativeBackend::new(app_handle.clone());
    macnative.init(config)?;
    Ok(macnative)
}

fn start_backend(state: &mut TabletState, backend: BackendType) -> Result<(), String> {
    match backend {
        BackendType::WinTab => state
            .wintab
            .as_mut()
            .ok_or_else(|| "WinTab backend is not initialized".to_string())?
            .start(),
        BackendType::MacNative => state
            .macnative
            .as_mut()
            .ok_or_else(|| "MacNative backend is not initialized".to_string())?
            .start(),
        BackendType::PointerEvent => state
            .pointer
            .as_mut()
            .ok_or_else(|| "PointerEvent backend is not initialized".to_string())?
            .start(),
    }
}

fn select_backend(
    state: &mut TabletState,
    requested_backend: BackendType,
    main_hwnd: Option<isize>,
    app_handle: &AppHandle,
) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    let _ = main_hwnd;

    let normalized_backend = normalize_requested_backend_for_platform(requested_backend);
    if normalized_backend != requested_backend {
        tracing::info!(
            "[Tablet] Requested backend '{}' is not supported on this platform, using '{}'",
            backend_type_name(requested_backend),
            backend_type_name(normalized_backend)
        );
    }

    state.requested_backend = normalized_backend;
    state.backend_type = normalized_backend;
    state.wintab = None;
    state.macnative = None;
    state.pointer = None;

    match normalized_backend {
        BackendType::WinTab => {
            state.wintab = Some(build_wintab_backend(&state.config, main_hwnd)?);
        }
        BackendType::MacNative => {
            state.macnative = Some(build_mac_native_backend(&state.config, app_handle)?);
        }
        BackendType::PointerEvent => {
            state.pointer = Some(build_pointer_backend(&state.config)?);
        }
    }

    Ok(())
}

/// Tablet status response for frontend
#[derive(Debug, Clone, Serialize)]
pub struct TabletStatusResponse {
    pub status: TabletStatus,
    pub backend: String,
    pub requested_backend: String,
    pub active_backend: String,
    pub backpressure_mode: InputBackpressureMode,
    pub queue_metrics: InputQueueMetrics,
    pub info: Option<TabletInfo>,
}

/// Initialize tablet input system
#[tauri::command]
pub fn init_tablet(
    app: AppHandle,
    backend: Option<BackendType>,
    polling_rate: Option<u32>,
    pressure_curve: Option<String>,
    backpressure_mode: Option<String>,
) -> Result<TabletStatusResponse, String> {
    let state = get_tablet_state();
    let mut state = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    state.app_handle = Some(app.clone());

    if state.wintab.is_some() || state.macnative.is_some() || state.pointer.is_some() {
        tracing::info!("[Tablet] Already initialized, returning current status");
        return Ok(current_tablet_status_response(&mut state));
    }

    let main_hwnd = resolve_main_hwnd(&app);
    state.config.polling_rate_hz = polling_rate.unwrap_or(200);
    apply_tablet_runtime_config(
        &mut state,
        None,
        pressure_curve.as_deref(),
        backpressure_mode.as_deref(),
    );

    let requested_backend = backend.unwrap_or(default_backend_for_platform());
    select_backend(&mut state, requested_backend, main_hwnd, &app)?;
    Ok(current_tablet_status_response(&mut state))
}

/// Switch active tablet backend at runtime without restarting the app.
#[tauri::command]
pub fn switch_tablet_backend(
    app: AppHandle,
    backend: BackendType,
    polling_rate: Option<u32>,
    pressure_curve: Option<String>,
    backpressure_mode: Option<String>,
) -> Result<TabletStatusResponse, String> {
    let state = get_tablet_state();
    let mut state = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    state.app_handle = Some(app.clone());

    apply_tablet_runtime_config(
        &mut state,
        polling_rate,
        pressure_curve.as_deref(),
        backpressure_mode.as_deref(),
    );

    let was_streaming = state.emitter_running;
    if let Some(active) = state.active_backend() {
        active.stop();
    }

    let main_hwnd = resolve_main_hwnd(&app);
    select_backend(&mut state, backend, main_hwnd, &app)?;

    if was_streaming {
        let backend_to_start = state.backend_type;
        start_backend(&mut state, backend_to_start)?;
    }

    Ok(current_tablet_status_response(&mut state))
}

/// Start tablet input streaming
#[tauri::command]
pub fn start_tablet() -> Result<(), String> {
    let state = get_tablet_state();
    let mut state = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    let backend_to_start = state.backend_type;
    start_backend(&mut state, backend_to_start)?;

    if !state.emitter_running {
        if let Some(app) = state.app_handle.clone() {
            state.emitter_running = true;
            let state_clone = get_tablet_state();

            std::thread::spawn(move || {
                tracing::info!("[Tablet] Event emitter thread started");
                let mut events = Vec::with_capacity(64);

                loop {
                    let should_continue = {
                        let Ok(mut state) = state_clone.try_lock() else {
                            std::thread::sleep(std::time::Duration::from_millis(1));
                            continue;
                        };

                        if !state.emitter_running {
                            false
                        } else {
                            if let Some(backend) = state.active_backend() {
                                backend.poll(&mut events);
                            }
                            true
                        }
                    };

                    if !should_continue {
                        break;
                    }

                    if !events.is_empty() {
                        for event in events.drain(..) {
                            if let Err(e) = app.emit("tablet-event-v3", &event) {
                                tracing::error!("[Tablet] Failed to emit V3 event: {}", e);
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

    Ok(current_tablet_status_response(&mut state))
}

/// Toggle WinTab backend trace logs in Rust terminal output.
#[tauri::command]
pub fn set_wintab_trace_enabled(enabled: bool) -> Result<bool, String> {
    crate::input::wintab_backend::set_wintab_trace_enabled(enabled);
    Ok(crate::input::wintab_backend::is_wintab_trace_enabled())
}

/// Query current WinTab backend trace toggle state.
#[tauri::command]
pub fn get_wintab_trace_enabled() -> Result<bool, String> {
    Ok(crate::input::wintab_backend::is_wintab_trace_enabled())
}

/// Push pointer event from frontend (for PointerEvent backend)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PointerEventPayload {
    pub x: f32,
    pub y: f32,
    pub pressure: f32,
    pub tilt_x: f32,
    pub tilt_y: f32,
    pub rotation: Option<f32>,
    pub pointer_id: Option<u32>,
    pub phase: Option<InputPhase>,
    pub device_time_us: Option<u64>,
}

#[tauri::command]
pub fn push_pointer_event(payload: PointerEventPayload) -> Result<(), String> {
    let state = get_tablet_state();
    let state = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    if let Some(pointer) = &state.pointer {
        pointer.push_input(
            payload.x,
            payload.y,
            payload.pressure,
            payload.tilt_x,
            payload.tilt_y,
            payload.rotation.unwrap_or(0.0),
            payload.pointer_id.unwrap_or(0),
            payload.phase.unwrap_or(InputPhase::Move),
            payload.device_time_us,
        );
    }

    Ok(())
}
// ============================================================================
// Soft Brush SIMD Rendering
// ============================================================================

use crate::brush::soft_dab::{render_soft_dab, GaussParams};

// ============================================================================
// ABR Brush Import
// ============================================================================

use crate::abr::{AbrBrush, AbrParser, BrushPreset};
use crate::brush::library as brush_library;
use crate::brush::library::{
    BrushLibraryImportResult, BrushLibraryPreset, BrushLibraryPresetPayload, BrushLibrarySnapshot,
};
use crate::brush::{cache_brush_gray, cache_pattern_rgba};

/// Pattern metadata for frontend
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub mode: String,
}

/// ABR import result with benchmark info
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAbrResult {
    /// Brush presets (metadata only, textures via protocol)
    pub presets: Vec<BrushPreset>,
    /// Brush tips list for Dual Brush selector (includes tip-only brushes)
    pub tips: Vec<BrushPreset>,
    /// Imported patterns (metadata)
    pub patterns: Vec<PatternInfo>,
    /// Benchmark timing info
    pub benchmark: AbrBenchmark,
}

/// ABR import benchmark timing
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AbrBenchmark {
    /// Total import time in milliseconds
    pub total_ms: f64,
    /// File read time in milliseconds
    pub read_ms: f64,
    /// Parse time in milliseconds
    pub parse_ms: f64,
    /// Cache time in milliseconds
    pub cache_ms: f64,
    /// Number of brushes loaded
    pub brush_count: usize,
    /// Number of patterns (textures) loaded
    pub pattern_count: usize,
    /// Total raw texture bytes
    pub raw_bytes: usize,
    /// Total compressed bytes
    pub compressed_bytes: usize,
}

// ============================================================================
// File Format Support (ORA, TIFF)
// ============================================================================

use crate::core::adapters::{project_core_to_legacy, project_legacy_to_core};
use crate::core::contracts::ProjectDataCore;
use crate::file::{FileFormat, FileOperationResult, ProjectData};
use std::path::Path;

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

// ============================================================================
// ABR Brush Import Command
// ============================================================================

/// Import brushes from an ABR file (optimized: zero-encoding, LZ4 compression)
///
/// Parses a Photoshop ABR brush file, caches textures via BrushCache,
/// and returns lightweight metadata. Textures are served via `project://brush/{id}`.
#[tauri::command]
pub async fn import_abr_file(path: String) -> Result<ImportAbrResult, String> {
    import_abr_file_internal(&path)
}

#[tauri::command]
pub async fn import_abr_to_brush_library(path: String) -> Result<BrushLibraryImportResult, String> {
    let import_result = import_abr_file_internal(&path)?;
    brush_library::import_from_abr(&path, import_result.presets, import_result.tips)
}

fn import_abr_file_internal(path: &str) -> Result<ImportAbrResult, String> {
    let total_start = std::time::Instant::now();

    // Step 1: Read file
    let read_start = std::time::Instant::now();
    let data = std::fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
    let read_ms = read_start.elapsed().as_secs_f64() * 1000.0;

    // Step 2: Parse ABR
    let parse_start = std::time::Instant::now();
    let abr_file =
        AbrParser::parse(&data).map_err(|e| format!("Failed to parse ABR file: {}", e))?;
    let parse_ms = parse_start.elapsed().as_secs_f64() * 1000.0;

    // Step 3: Cache textures and build presets
    let cache_start = std::time::Instant::now();
    let mut raw_bytes: usize = 0;
    let mut pattern_decode_failures: usize = 0;
    let mut texture_pattern_resolved_by_name: usize = 0;
    let mut unresolved_texture_links: usize = 0;
    let mut duplicate_id_count: usize = 0;

    // Cache patterns first
    let mut pattern_infos = Vec::new();
    let mut pattern_name_map: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for pattern in &abr_file.patterns {
        // Use decode_image_with_dimensions() to get both RGBA data AND actual dimensions
        // The VMA structure may have different dimensions than pattern metadata
        let (rgba_data, actual_width, actual_height) = match pattern.decode_image_with_dimensions()
        {
            Some(result) => result,
            None => {
                pattern_decode_failures += 1;
                continue;
            }
        };

        if pattern.id.is_empty() {
            // Generate a UUID if missing - though parser usually handles this
            continue;
        }

        // CACHE THE PATTERN WITH ACTUAL DIMENSIONS!
        // Use actual_width/height from VMA, not pattern metadata
        cache_pattern_rgba(
            pattern.id.clone(),
            rgba_data, // Use the converted RGBA data
            actual_width,
            actual_height,
            pattern.name.clone(),
            pattern.mode_name().to_string(),
        );

        pattern_infos.push(PatternInfo {
            id: pattern.id.clone(),
            name: pattern.name.clone(),
            width: actual_width,
            height: actual_height,
            mode: pattern.mode_name().to_string(),
        });

        // Add to name map for fallback lookup
        pattern_name_map.insert(pattern.name.clone(), pattern.id.clone());

        raw_bytes += pattern.data.len();
    }

    let mut presets: Vec<BrushPreset> = Vec::with_capacity(abr_file.brushes.len());
    let mut tips: Vec<BrushPreset> = Vec::with_capacity(abr_file.brushes.len());
    // Track usage of IDs to ensure uniqueness within this import batch
    // Map ID -> count (how many times seen so far)
    let mut id_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for mut brush in abr_file.brushes {
        let is_tip_only = brush.is_tip_only;

        if let Some(ref mut tex) = brush.texture_settings {
            // Resolution Logic:
            let mut resolved = false;
            // 1. Check if pattern_id exists in our loaded patterns
            if let Some(ref pid) = tex.pattern_id {
                if pattern_infos.iter().any(|p| p.id == *pid) {
                    resolved = true;
                }
            }

            // 2. Fallback: Lookup by Name
            if !resolved {
                if let Some(ref pname) = tex.pattern_name {
                    if let Some(mapped_id) = pattern_name_map.get(pname) {
                        tex.pattern_id = Some(mapped_id.clone());
                        texture_pattern_resolved_by_name += 1;
                        resolved = true;
                    }
                }
            }

            if !resolved && tex.enabled {
                unresolved_texture_links += 1;
            }
        }
        // Generate base ID (from UUID or random)
        let base_id = brush.uuid.clone().unwrap_or_else(uuid_simple);

        // Ensure uniqueness
        let count = id_counts.entry(base_id.clone()).or_insert(0);
        let id = if *count == 0 {
            base_id.clone()
        } else {
            // Append suffix for duplicates: uuid-1, uuid-2, etc.
            format!("{}-{}", base_id, count)
        };
        *count += 1;

        if id != base_id {
            duplicate_id_count += 1;
        }

        // Cache texture if present (skip computed brushes - render procedurally)
        if let Some(ref tip) = brush.tip_image {
            if !brush.is_computed {
                raw_bytes += tip.data.len();
                cache_brush_gray(
                    id.clone(),
                    tip.data.clone(),
                    tip.width,
                    tip.height,
                    brush.name.clone(),
                );
            }
        }

        // Build preset with the ID we generated
        let preset = build_preset_with_id(brush, id);
        if is_tip_only {
            tips.push(preset);
            continue;
        }

        presets.push(preset.clone());
        tips.push(preset);
    }

    let cache_ms = cache_start.elapsed().as_secs_f64() * 1000.0;

    // Get compressed size from cache stats
    let (_, compressed_bytes) = crate::brush::get_brush_cache_stats();
    let brush_count = presets.len();

    let total_ms = total_start.elapsed().as_secs_f64() * 1000.0;

    // Benchmark logging
    let compression_ratio = if raw_bytes > 0 {
        compressed_bytes as f64 / raw_bytes as f64 * 100.0
    } else {
        0.0
    };

    let import_diagnostics = format!(
        "parse_version={:?}, decode_failures={}, texture_name_fallbacks={}, unresolved_texture_links={}, duplicate_ids={}",
        abr_file.version,
        pattern_decode_failures,
        texture_pattern_resolved_by_name,
        unresolved_texture_links,
        duplicate_id_count
    );
    tracing::info!(
        "[ABR Benchmark] Loaded {} brushes in {:.2}ms (read: {:.2}ms, parse: {:.2}ms, cache: {:.2}ms) | {}",
        brush_count,
        total_ms,
        read_ms,
        parse_ms,
        cache_ms,
        import_diagnostics
    );
    tracing::info!(
        "[ABR Benchmark] Texture data: {} KB raw -> {} KB compressed ({:.1}%)",
        raw_bytes / 1024,
        compressed_bytes / 1024,
        compression_ratio
    );

    Ok(ImportAbrResult {
        presets,
        tips,
        patterns: pattern_infos,
        benchmark: AbrBenchmark {
            total_ms,
            read_ms,
            parse_ms,
            cache_ms,
            brush_count,
            pattern_count: abr_file.patterns.len(),
            raw_bytes,
            compressed_bytes,
        },
    })
}

/// Build BrushPreset with a specific ID (used when we generate ID before caching)
fn build_preset_with_id(brush: AbrBrush, id: String) -> BrushPreset {
    let mut preset: BrushPreset = brush.into();
    preset.id = id;
    preset
}

// ============================================================================
// File Save/Load Commands
// ============================================================================

/// Save project to file (ORA or PSD format)
#[tauri::command]
pub async fn save_project(
    path: String,
    format: FileFormat,
    project: ProjectData,
) -> Result<FileOperationResult, String> {
    let project_core = project_legacy_to_core(&project)?;
    save_project_v2(path, format, project_core).await
}

/// Save project to file (V2 core contract with bytes-first payload)
#[tauri::command]
pub async fn save_project_v2(
    path: String,
    format: FileFormat,
    project: ProjectDataCore,
) -> Result<FileOperationResult, String> {
    tracing::info!("Saving project to: {} (format: {:?})", path, format);

    let path_ref = Path::new(&path);
    let result = crate::core::formats::save_project_core(path_ref, format, &project);

    match result {
        Ok(()) => {
            tracing::info!("Project saved successfully: {}", path);
            Ok(FileOperationResult::success(path))
        }
        Err(e) => {
            tracing::error!("Failed to save project: {}", e);
            Ok(FileOperationResult::error(e.to_string()))
        }
    }
}

/// Load project from file (auto-detects format from extension)
#[tauri::command]
pub async fn load_project(path: String) -> Result<ProjectData, String> {
    let project_core = load_project_v2(path).await?;
    Ok(project_core_to_legacy(&project_core))
}

/// Load project from file (V2 core contract with bytes-first payload)
#[tauri::command]
pub async fn load_project_v2(path: String) -> Result<ProjectDataCore, String> {
    tracing::info!("Loading project from: {}", path);

    let path_ref = Path::new(&path);
    let result = crate::core::formats::load_project_core(path_ref);

    match result {
        Ok(project) => {
            tracing::info!(
                "Project loaded: {}x{}, {} layers",
                project.width,
                project.height,
                project.layers.len()
            );

            // Start benchmark session if benchmark data is present
            if let Some(ref benchmark) = project.benchmark {
                crate::benchmark::start_session(benchmark.clone());
            }

            Ok(project)
        }
        Err(e) => {
            tracing::error!("Failed to load project: {}", e);
            Err(e.to_string())
        }
    }
}

/// Report frontend benchmark phase timing
///
/// Called by frontend after each loading phase completes.
/// When phase is "complete", outputs the unified benchmark report and returns it for console logging.
#[tauri::command]
pub fn report_benchmark(session_id: String, phase: String, duration_ms: f64) -> Option<String> {
    crate::benchmark::report_phase(&session_id, &phase, duration_ms)
}

/// Detect file format from path extension
#[tauri::command]
pub fn detect_file_format(path: String) -> Option<FileFormat> {
    FileFormat::from_path(&path)
}

/// Delete file if it exists
#[tauri::command]
pub fn delete_file_if_exists(path: String) -> Result<(), String> {
    let path_ref = Path::new(&path);
    if !path_ref.exists() {
        return Ok(());
    }
    std::fs::remove_file(path_ref).map_err(|e| e.to_string())
}

/// Reveal file in system explorer (Windows only)
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("path cannot be empty".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // Explorer frequently returns non-zero exit code even when it successfully opens.
        // For UX, treat successful process launch as success.
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("reveal_in_explorer is only supported on Windows".to_string())
    }
}

// ============================================================================
// Brush Library Commands
// ============================================================================

#[tauri::command]
pub fn get_brush_library() -> BrushLibrarySnapshot {
    brush_library::get_library_snapshot()
}

#[tauri::command]
pub fn rename_brush_preset(id: String, new_name: String) -> Result<(), String> {
    brush_library::rename_preset(&id, new_name)
}

#[tauri::command]
pub fn delete_brush_preset(id: String) -> Result<(), String> {
    brush_library::delete_preset(&id)
}

#[tauri::command]
pub fn move_brush_preset_to_group(id: String, group: String) -> Result<(), String> {
    brush_library::move_preset_to_group(&id, group)
}

#[tauri::command]
pub fn rename_brush_group(old_name: String, new_name: String) -> Result<(), String> {
    brush_library::rename_group(&old_name, new_name)
}

#[tauri::command]
pub fn delete_brush_group(group_name: String) -> Result<(), String> {
    brush_library::delete_group(&group_name)
}

#[tauri::command]
pub fn save_brush_preset(payload: BrushLibraryPresetPayload) -> Result<BrushLibraryPreset, String> {
    brush_library::save_preset(payload)
}

#[tauri::command]
pub fn save_brush_preset_as(
    payload: BrushLibraryPresetPayload,
    new_name: String,
    target_group: Option<String>,
) -> Result<BrushLibraryPreset, String> {
    brush_library::save_preset_as(payload, new_name, target_group)
}

// ============================================================================
// Pattern Library Commands
// ============================================================================

use crate::pattern::{
    self, AddPatternFromBrushResult, ImportResult as PatternImportResult, PatternMode,
    PatternResource,
};

/// Get all patterns from the library
#[tauri::command]
pub fn get_patterns() -> Vec<PatternResource> {
    pattern::library::get_all_patterns()
}

/// Import a .pat file into the library
#[tauri::command]
pub async fn import_pat_file(path: String) -> Result<PatternImportResult, String> {
    let path_ref = std::path::Path::new(&path);
    pattern::library::import_pat_file(path_ref)
}

/// Add current brush-attached pattern into the pattern library
#[tauri::command]
pub fn add_pattern_from_brush(
    pattern_id: String,
    name: Option<String>,
) -> Result<AddPatternFromBrushResult, String> {
    let cached = crate::brush::get_cached_pattern(&pattern_id)
        .ok_or_else(|| format!("Pattern not found in cache: {}", pattern_id))?;

    let rgba_data = lz4_flex::decompress_size_prepended(&cached.data)
        .map_err(|e| format!("Failed to decompress pattern {}: {}", pattern_id, e))?;

    let mode = match cached.mode.as_str() {
        "Grayscale" => PatternMode::Grayscale,
        "RGB" => PatternMode::RGB,
        "Indexed" => PatternMode::Indexed,
        other => return Err(format!("Unsupported pattern mode '{}'", other)),
    };

    let resolved_name = name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            if cached.name.trim().is_empty() {
                format!("Brush Pattern {}", pattern_id)
            } else {
                cached.name.clone()
            }
        });

    pattern::library::add_from_brush(
        &pattern_id,
        resolved_name,
        rgba_data,
        cached.width,
        cached.height,
        mode,
    )
}

/// Delete a pattern from the library
#[tauri::command]
pub fn delete_pattern(id: String) -> Result<(), String> {
    pattern::library::delete_pattern(&id)
}

/// Rename a pattern
#[tauri::command]
pub fn rename_pattern(id: String, new_name: String) -> Result<(), String> {
    pattern::library::rename_pattern(&id, new_name)
}

/// Move a pattern to a different group
#[tauri::command]
pub fn move_pattern_to_group(id: String, group: String) -> Result<(), String> {
    pattern::library::move_to_group(&id, group)
}

/// Rename a group
#[tauri::command]
pub fn rename_pattern_group(old_name: String, new_name: String) -> Result<(), String> {
    pattern::library::rename_group(&old_name, new_name)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use image::{ImageBuffer, ImageFormat, Rgba};

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

    #[test]
    fn test_build_preset_preserves_texture_settings() {
        use crate::abr::{AbrBrush, TextureSettings};

        let texture_settings = TextureSettings {
            enabled: true,
            pattern_id: Some("test-pattern-id".to_string()),
            ..Default::default()
        };

        let brush = AbrBrush {
            name: "Test Brush".to_string(),
            uuid: Some("test-uuid".to_string()),
            tip_image: None,
            diameter: 100.0,
            spacing: 0.25,
            angle: 0.0,
            roundness: 1.0,
            hardness: None,
            dynamics: None,
            is_computed: false,
            is_tip_only: false,
            texture_settings: Some(texture_settings),
            dual_brush_settings: None,
            shape_dynamics_enabled: None,
            shape_dynamics: None,
            scatter_enabled: None,
            scatter: None,
            color_dynamics_enabled: None,
            color_dynamics: None,
            transfer_enabled: None,
            transfer: None,
            wet_edge_enabled: None,
            buildup_enabled: None,
            noise_enabled: None,
            base_opacity: None,
            base_flow: None,
        };

        let preset = build_preset_with_id(brush, "preset-id".to_string());

        assert!(preset.texture_settings.is_some());
        assert_eq!(
            preset.texture_settings.unwrap().pattern_id,
            Some("test-pattern-id".to_string())
        );
    }

    #[test]
    fn test_planar_decoding() {
        // R: [10, 20], G: [30, 40], B: [50, 60]
        // Flattened Planar: 10, 20, 30, 40, 50, 60
        // Expected RGBA: (10,30,50,255), (20,40,60,255)

        let decoded: &[u8] = &[10, 20, 30, 40, 50, 60];
        let pixel_count = 2;
        let area = pixel_count;
        let mut rgba_data = Vec::new();

        if decoded.len() >= area * 3 {
            let (r_plane, rest) = decoded.split_at(area);
            let (g_plane, b_rest) = rest.split_at(area);
            let b_plane = &b_rest[..area];

            for i in 0..area {
                rgba_data.extend_from_slice(&[r_plane[i], g_plane[i], b_plane[i], 255]);
            }
        }

        assert_eq!(rgba_data.len(), 8);
        assert_eq!(rgba_data, vec![10, 30, 50, 255, 20, 40, 60, 255]);
    }

    #[test]
    fn test_backend_type_name_includes_macnative() {
        assert_eq!(backend_type_name(BackendType::MacNative), "macnative");
    }

    #[test]
    fn test_default_backend_for_platform() {
        #[cfg(target_os = "windows")]
        assert_eq!(default_backend_for_platform(), BackendType::WinTab);

        #[cfg(target_os = "macos")]
        assert_eq!(default_backend_for_platform(), BackendType::MacNative);

        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        assert_eq!(default_backend_for_platform(), BackendType::PointerEvent);
    }

    #[test]
    fn test_normalize_requested_backend_for_platform() {
        #[cfg(target_os = "windows")]
        {
            assert_eq!(
                normalize_requested_backend_for_platform(BackendType::MacNative),
                BackendType::WinTab
            );
            assert_eq!(
                normalize_requested_backend_for_platform(BackendType::PointerEvent),
                BackendType::PointerEvent
            );
        }

        #[cfg(target_os = "macos")]
        {
            assert_eq!(
                normalize_requested_backend_for_platform(BackendType::WinTab),
                BackendType::MacNative
            );
            assert_eq!(
                normalize_requested_backend_for_platform(BackendType::PointerEvent),
                BackendType::PointerEvent
            );
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            assert_eq!(
                normalize_requested_backend_for_platform(BackendType::WinTab),
                BackendType::PointerEvent
            );
            assert_eq!(
                normalize_requested_backend_for_platform(BackendType::MacNative),
                BackendType::PointerEvent
            );
            assert_eq!(
                normalize_requested_backend_for_platform(BackendType::PointerEvent),
                BackendType::PointerEvent
            );
        }
    }

    fn encode_png_data_url(r: u8, g: u8, b: u8, a: u8) -> String {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

        let img = ImageBuffer::from_pixel(1, 1, Rgba([r, g, b, a]));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut cursor, ImageFormat::Png)
            .expect("png encode should succeed");
        format!(
            "data:image/png;base64,{}",
            BASE64.encode(cursor.into_inner())
        )
    }

    fn sample_legacy_project() -> ProjectData {
        ProjectData {
            width: 1,
            height: 1,
            dpi: 72,
            layers: vec![crate::file::LayerData {
                id: "layer_legacy".to_string(),
                name: "Legacy Layer".to_string(),
                layer_type: "raster".to_string(),
                visible: true,
                locked: false,
                opacity: 1.0,
                blend_mode: "normal".to_string(),
                is_background: Some(true),
                image_data: Some(encode_png_data_url(255, 0, 0, 255)),
                offset_x: 0,
                offset_y: 0,
            }],
            flattened_image: Some(encode_png_data_url(255, 0, 0, 255)),
            thumbnail: Some(encode_png_data_url(255, 0, 0, 255)),
            benchmark: None,
        }
    }

    fn sample_core_project() -> crate::core::contracts::ProjectDataCore {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

        let data_url = encode_png_data_url(0, 255, 0, 255);
        let png_bytes = BASE64
            .decode(data_url.trim_start_matches("data:image/png;base64,"))
            .expect("decode should succeed");

        crate::core::contracts::ProjectDataCore {
            width: 1,
            height: 1,
            dpi: 72,
            layers: vec![crate::core::contracts::LayerDataCore {
                id: "layer_core".to_string(),
                name: "Core Layer".to_string(),
                layer_type: "raster".to_string(),
                visible: true,
                locked: false,
                opacity: 1.0,
                blend_mode: "normal".to_string(),
                is_background: Some(true),
                offset_x: 0,
                offset_y: 0,
                layer_png_bytes: Some(png_bytes.clone()),
                legacy_image_data_base64: None,
            }],
            flattened_png_bytes: Some(png_bytes.clone()),
            thumbnail_png_bytes: Some(png_bytes),
            legacy_flattened_image_base64: None,
            legacy_thumbnail_base64: None,
            benchmark: None,
        }
    }

    fn temp_file_path(ext: &str) -> String {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("sutu_cmd_compat_{}.{}", ts, ext))
            .to_string_lossy()
            .to_string()
    }

    #[tokio::test]
    async fn test_save_project_v2_and_load_project_v2() {
        let path = temp_file_path("ora");
        let result = save_project_v2(path.clone(), FileFormat::Ora, sample_core_project())
            .await
            .expect("save v2 should return result");
        assert!(result.success);

        let loaded = load_project_v2(path.clone())
            .await
            .expect("load v2 should succeed");
        assert_eq!(loaded.width, 1);
        assert_eq!(loaded.height, 1);
        assert_eq!(loaded.layers.len(), 1);

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn test_save_project_legacy_is_compatible_with_load_project_v2() {
        let path = temp_file_path("psd");
        let result = save_project(path.clone(), FileFormat::Psd, sample_legacy_project())
            .await
            .expect("legacy save should return result");
        assert!(result.success);

        let loaded = load_project_v2(path.clone())
            .await
            .expect("load v2 should succeed after legacy save");
        assert_eq!(loaded.width, 1);
        assert_eq!(loaded.height, 1);
        assert!(!loaded.layers.is_empty());

        let _ = std::fs::remove_file(path);
    }
}

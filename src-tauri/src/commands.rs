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

// ============================================================================
// ABR Brush Import
// ============================================================================

use crate::abr::{AbrBrush, AbrParser, BrushPreset};
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
    let total_start = std::time::Instant::now();

    tracing::info!("[ABR Import] Starting import: {}", path);

    // Step 1: Read file
    let read_start = std::time::Instant::now();
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    let read_ms = read_start.elapsed().as_secs_f64() * 1000.0;
    tracing::debug!(
        "[ABR Import] File read: {} bytes in {:.2}ms",
        data.len(),
        read_ms
    );

    // Step 2: Parse ABR
    let parse_start = std::time::Instant::now();
    let abr_file =
        AbrParser::parse(&data).map_err(|e| format!("Failed to parse ABR file: {}", e))?;
    let parse_ms = parse_start.elapsed().as_secs_f64() * 1000.0;
    tracing::debug!(
        "[ABR Import] Parsed: version={:?}, {} brushes in {:.2}ms",
        abr_file.version,
        abr_file.brushes.len(),
        parse_ms
    );

    // Log pattern count for debugging
    if !abr_file.patterns.is_empty() {
        tracing::info!(
            "[ABR Import] Found {} patterns (textures)",
            abr_file.patterns.len()
        );
        for (i, p) in abr_file.patterns.iter().enumerate() {
            tracing::info!(
                "[ABR Pattern #{}] Name='{}' ID='{}' FoundInPatt=true",
                i,
                p.name,
                p.id
            );
        }
    }

    // Step 3: Cache textures and build presets
    let cache_start = std::time::Instant::now();
    let mut raw_bytes: usize = 0;

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
                tracing::warn!(
                    "[ABR Import] Failed to decode pattern '{}' ({}x{}, {})",
                    pattern.name,
                    pattern.width,
                    pattern.height,
                    pattern.mode_name()
                );
                continue;
            }
        };

        {
            if pattern.id.is_empty() {
                // Generate a UUID if missing - though parser usually handles this
                continue;
            }

            tracing::info!(
                "[BrushPresets] Imported pattern: '{}' ({}x{} -> actual {}x{}, {}) ID: {}",
                pattern.name,
                pattern.width,
                pattern.height,
                actual_width,
                actual_height,
                pattern.mode_name(),
                pattern.id
            );

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
    }

    let mut presets: Vec<BrushPreset> = Vec::with_capacity(abr_file.brushes.len());
    let mut tips: Vec<BrushPreset> = Vec::with_capacity(abr_file.brushes.len());
    // Track usage of IDs to ensure uniqueness within this import batch
    // Map ID -> count (how many times seen so far)
    let mut id_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for mut brush in abr_file.brushes {
        let is_tip_only = brush.is_tip_only;

        // Debug connection between brush and pattern
        if let Some(ref mut tex) = brush.texture_settings {
            tracing::info!(
                "[ABR Brush Link] Brush '{}' requests Pattern ID '{:?}' Name '{:?}'",
                brush.name,
                tex.pattern_id,
                tex.pattern_name
            );

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
                        tracing::warn!(
                            "[ABR Fix] Resolved pattern mismatch for brush '{}': UUID '{:?}' -> Name '{}' -> ID '{}'",
                            brush.name,
                            tex.pattern_id,
                            pname,
                            mapped_id
                        );
                        tex.pattern_id = Some(mapped_id.clone());
                        resolved = true;
                    }
                }
            }

            if !resolved && tex.enabled {
                tracing::warn!("[ABR Warning] Brush '{}' has texture enabled but pattern could not be resolved.", brush.name);
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
            tracing::info!(
                "[ABR Import] resolved duplicate ID for brush '{}': {} -> {}",
                brush.name,
                base_id,
                id
            );
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

    tracing::info!(
        "[ABR Benchmark] Loaded {} brushes in {:.2}ms (read: {:.2}ms, parse: {:.2}ms, cache: {:.2}ms)",
        brush_count,
        total_ms,
        read_ms,
        parse_ms,
        cache_ms
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
    tracing::info!("Saving project to: {} (format: {:?})", path, format);

    let path_ref = Path::new(&path);

    let result = match format {
        FileFormat::Ora => crate::file::ora::save_ora(path_ref, &project),
        FileFormat::Tiff => {
            // TIFF format is disabled due to implementation issues
            return Ok(FileOperationResult::error(
                "TIFF format is currently disabled".to_string(),
            ));
        }
        FileFormat::Psd => crate::file::psd::save_psd(path_ref, &project),
    };

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
    tracing::info!("Loading project from: {}", path);

    let path_ref = Path::new(&path);

    // Auto-detect format from extension
    let format =
        FileFormat::from_path(&path).ok_or_else(|| format!("Unknown file format: {}", path))?;

    let result = match format {
        FileFormat::Ora => crate::file::ora::load_ora(path_ref),
        FileFormat::Tiff => {
            // TIFF format is disabled due to implementation issues
            return Err("TIFF format is currently disabled".to_string());
        }
        FileFormat::Psd => crate::file::psd::load_psd(path_ref),
    };

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

// ============================================================================
// Pattern Library Commands
// ============================================================================

use crate::pattern::{self, ImportResult as PatternImportResult, PatternResource};

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
}

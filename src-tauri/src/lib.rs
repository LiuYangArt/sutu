//! Sutu - Professional painting software with low-latency pen input
#![allow(clippy::expect_used)]

//!
//! This is the main library crate that exposes all modules for the Tauri backend.

pub mod abr;
pub mod app_meta;
pub mod bench;
pub mod benchmark;
pub mod brush;
pub mod commands;
pub mod file;
pub mod input;
pub mod pattern;

use tauri::http::{Response, StatusCode};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// Initialize the application
pub fn init() {
    // Setup logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                format!("{}=debug,tauri=info", app_meta::APP_LOG_TARGET).into()
            }),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Initialize layer cache
    file::init_cache();

    // Initialize pattern library
    pattern::library::init_library();
    // Initialize brush library
    brush::library::init_library();

    tracing::info!("{} initializing...", app_meta::APP_DISPLAY_NAME);
}

/// Build HTTP response for custom protocol
fn build_response(data: Vec<u8>, mime_type: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", mime_type)
        .header("Access-Control-Allow-Origin", "*")
        .body(data)
        .expect("failed to build response")
}

/// Build HTTP response for raw RGBA data with dimension headers
fn build_rgba_response(data: Vec<u8>, width: u32, height: u32) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "image/x-rgba")
        .header("Access-Control-Allow-Origin", "*")
        .header(
            "Access-Control-Expose-Headers",
            "X-Image-Width, X-Image-Height",
        )
        .header("X-Image-Width", width.to_string())
        .header("X-Image-Height", height.to_string())
        .body(data)
        .expect("failed to build response")
}

/// Build HTTP response for LZ4-compressed RGBA data with dimension headers
fn build_rgba_lz4_response(data: Vec<u8>, width: u32, height: u32) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "image/x-rgba-lz4")
        .header("Access-Control-Allow-Origin", "*")
        .header(
            "Access-Control-Expose-Headers",
            "X-Image-Width, X-Image-Height",
        )
        .header("X-Image-Width", width.to_string())
        .header("X-Image-Height", height.to_string())
        .body(data)
        .expect("failed to build response")
}

/// Build HTTP response for LZ4-compressed Gray8 data with dimension headers
fn build_gray_lz4_response(data: Vec<u8>, width: u32, height: u32) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "image/x-gray-lz4")
        .header("Access-Control-Allow-Origin", "*")
        .header(
            "Access-Control-Expose-Headers",
            "X-Image-Width, X-Image-Height",
        )
        .header("X-Image-Width", width.to_string())
        .header("X-Image-Height", height.to_string())
        .body(data)
        .expect("failed to build response")
}

/// Build 404 response
fn build_not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Content-Type", "text/plain")
        .body(b"Not Found".to_vec())
        .expect("failed to build response")
}

/// Run the Tauri application
///
/// # Panics
/// Panics if the Tauri application fails to start.
#[allow(clippy::expect_used)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Register custom protocol for serving layer images
        // Usage: <img src="project://layer/{layer_id}" />
        //        <img src="project://thumbnail" />
        .register_uri_scheme_protocol("project", |_ctx, request| {
            let path = request.uri().path();
            tracing::trace!("project:// request: {}", path);

            // Parse path: /layer/{id} or /thumbnail or /brush/{id}
            if let Some(layer_id) = path.strip_prefix("/layer/") {
                tracing::trace!("Looking up layer in cache: {}", layer_id);
                if let Some(cached) = file::get_cached_layer(layer_id) {
                    tracing::trace!(
                        "Cache HIT: {} ({} bytes, type: {})",
                        layer_id,
                        cached.data.len(),
                        cached.mime_type
                    );
                    // Use special response for raw RGBA data (uncompressed or LZ4)
                    if cached.mime_type == "image/x-rgba" {
                        let width = cached.width.unwrap_or(0);
                        let height = cached.height.unwrap_or(0);
                        return build_rgba_response(cached.data, width, height);
                    }
                    if cached.mime_type == "image/x-rgba-lz4" {
                        let width = cached.width.unwrap_or(0);
                        let height = cached.height.unwrap_or(0);
                        return build_rgba_lz4_response(cached.data, width, height);
                    }
                    return build_response(cached.data, cached.mime_type);
                } else {
                    tracing::warn!("Cache MISS: {}", layer_id);
                }
            } else if let Some(brush_id) = path.strip_prefix("/brush/") {
                // Brush texture endpoint: /brush/{id}
                tracing::trace!("Looking up brush in cache: {}", brush_id);
                if let Some(cached) = brush::get_cached_brush(brush_id) {
                    tracing::trace!(
                        "Brush cache HIT: {} ({} bytes, {}x{})",
                        brush_id,
                        cached.data.len(),
                        cached.width,
                        cached.height
                    );
                    return build_gray_lz4_response(cached.data, cached.width, cached.height);
                } else {
                    tracing::warn!("Brush cache MISS: {}", brush_id);
                }
            } else if let Some(pattern_id) = path.strip_prefix("/pattern/") {
                // Pattern texture endpoint: /pattern/{id}
                tracing::trace!("Looking up pattern in cache: {}", pattern_id);
                let thumb = request.uri().query().and_then(|q| {
                    q.split('&').find_map(|part| {
                        let v = part.strip_prefix("thumb=")?;
                        v.parse::<u32>().ok()
                    })
                });

                if let Some(size) = thumb {
                    if let Some(cached) = brush::get_cached_pattern_thumb(pattern_id, size) {
                        tracing::trace!(
                            "Pattern thumb cache HIT: {} ({} bytes, {}x{})",
                            pattern_id,
                            cached.data.len(),
                            cached.width,
                            cached.height
                        );
                        return build_rgba_lz4_response(cached.data, cached.width, cached.height);
                    }
                } else if let Some(cached) = brush::get_cached_pattern(pattern_id) {
                    tracing::trace!(
                        "Pattern cache HIT: {} ({} bytes, {}x{})",
                        pattern_id,
                        cached.data.len(),
                        cached.width,
                        cached.height
                    );
                    return build_rgba_lz4_response(cached.data, cached.width, cached.height);
                }

                tracing::warn!("Pattern cache MISS: {} (thumb={:?})", pattern_id, thumb);
            } else if path == "/thumbnail" {
                if let Some(cached) = file::get_cached_thumbnail() {
                    return build_response(cached.data, cached.mime_type);
                }
            }

            build_not_found()
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_document,
            commands::get_system_info,
            commands::process_stroke,
            commands::run_wintab_spike,
            commands::check_wintab_available,
            commands::init_tablet,
            commands::switch_tablet_backend,
            commands::start_tablet,
            commands::stop_tablet,
            commands::get_tablet_status,
            commands::push_pointer_event,
            commands::stamp_soft_dab,
            commands::import_abr_file,
            commands::import_abr_to_brush_library,
            // Brush Library
            commands::get_brush_library,
            commands::rename_brush_preset,
            commands::delete_brush_preset,
            commands::move_brush_preset_to_group,
            commands::rename_brush_group,
            commands::delete_brush_group,
            commands::save_brush_preset,
            commands::save_brush_preset_as,
            // File operations
            commands::save_project,
            commands::load_project,
            commands::detect_file_format,
            commands::delete_file_if_exists,
            commands::reveal_in_explorer,
            // Pattern Library
            commands::get_patterns,
            commands::import_pat_file,
            commands::add_pattern_from_brush,
            commands::delete_pattern,
            commands::rename_pattern,
            commands::move_pattern_to_group,
            commands::rename_pattern_group,
            // Benchmark
            commands::report_benchmark,
            bench::start_benchmark,
        ])
        .setup(|_app| {
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

//! PaintBoard - Professional painting software with low-latency pen input
//!
//! This is the main library crate that exposes all modules for the Tauri backend.

pub mod brush;
pub mod commands;
pub mod input;

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// Initialize the application
pub fn init() {
    // Setup logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "paintboard=debug,tauri=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("PaintBoard initializing...");
}

/// Run the Tauri application
///
/// # Panics
/// Panics if the Tauri application fails to start.
#[allow(clippy::expect_used)]
pub fn run() {
    init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::create_document,
            commands::get_system_info,
            commands::process_stroke,
            commands::run_wintab_spike,
            commands::check_wintab_available,
            commands::init_tablet,
            commands::start_tablet,
            commands::stop_tablet,
            commands::get_tablet_status,
            commands::push_pointer_event,
            commands::stamp_soft_dab,
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

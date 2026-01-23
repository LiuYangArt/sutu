//! Unified benchmark reporting for file open operations
//!
//! Collects timing data from both backend (Rust) and frontend (TypeScript),
//! then outputs a formatted report to the terminal.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// Backend benchmark data collected during file loading
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendBenchmark {
    /// Unique session ID to correlate frontend/backend data
    pub session_id: String,
    /// File path being loaded
    pub file_path: String,
    /// File format (psd/ora)
    pub format: String,
    /// Phase 1: File read from disk (ms)
    pub file_read_ms: f64,
    /// Phase 2: Format parsing (ms)
    pub format_parse_ms: f64,
    /// Phase 3+4: Decode and cache (ms)
    pub decode_cache_ms: f64,
    /// Total backend time (ms)
    pub total_ms: f64,
    /// Number of layers
    pub layer_count: usize,
    /// Timestamp when data was sent to frontend
    #[serde(skip)]
    pub send_timestamp: Option<Instant>,
}

/// Complete benchmark session data
#[derive(Debug, Default)]
struct BenchmarkSession {
    backend: Option<BackendBenchmark>,
    frontend_phases: HashMap<String, f64>,
    ipc_transfer_ms: Option<f64>,
}

/// Global benchmark session storage
static CURRENT_SESSION: Mutex<Option<BenchmarkSession>> = Mutex::new(None);

/// Start a new benchmark session (called from load_project)
pub fn start_session(benchmark: BackendBenchmark) {
    let mut session = CURRENT_SESSION.lock().unwrap_or_else(|e| e.into_inner());
    *session = Some(BenchmarkSession {
        backend: Some(benchmark),
        frontend_phases: HashMap::new(),
        ipc_transfer_ms: None,
    });
}

/// Report a frontend phase timing
pub fn report_phase(session_id: &str, phase: &str, duration_ms: f64) {
    let mut session_guard = CURRENT_SESSION.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(session) = session_guard.as_mut() {
        // Verify session ID matches
        if let Some(backend) = &session.backend {
            if backend.session_id != session_id {
                tracing::warn!(
                    "[Benchmark] Session ID mismatch: expected {}, got {}",
                    backend.session_id,
                    session_id
                );
                return;
            }
        }

        // Handle special phases
        match phase {
            "ipc_transfer" => {
                session.ipc_transfer_ms = Some(duration_ms);
            }
            "complete" => {
                // Print the final report
                print_report(session);
                // Clear session after report
                *session_guard = None;
            }
            _ => {
                session
                    .frontend_phases
                    .insert(phase.to_string(), duration_ms);
            }
        }
    }
}

/// Print the formatted benchmark report
fn print_report(session: &BenchmarkSession) {
    let Some(backend) = &session.backend else {
        return;
    };

    // Calculate frontend subtotal
    let frontend_subtotal: f64 = session.frontend_phases.values().sum();
    let ipc_ms = session.ipc_transfer_ms.unwrap_or(0.0);

    // Calculate grand total
    let total = backend.total_ms + ipc_ms + frontend_subtotal;

    // Extract file name from path
    let file_name = std::path::Path::new(&backend.file_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| backend.file_path.clone());

    // Build the report
    let width = 62;
    let line = "=".repeat(width);
    let thin_line = "-".repeat(width);

    println!();
    println!("{}", line);
    println!(
        "{:^width$}",
        format!("File Open Benchmark [{}]", backend.format.to_uppercase()),
        width = width
    );
    println!("{}", line);
    println!(" File: {}", file_name);
    println!("{}", thin_line);

    // Backend section
    println!(" Backend");
    println!("   File read:         {:>8.1} ms", backend.file_read_ms);
    println!("   Format parse:      {:>8.1} ms", backend.format_parse_ms);
    println!("   Decode + Cache:    {:>8.1} ms", backend.decode_cache_ms);
    println!("   --------------------------------");
    println!("   Subtotal:          {:>8.1} ms", backend.total_ms);

    println!("{}", thin_line);

    // IPC section
    println!(" IPC Transfer:        {:>8.1} ms", ipc_ms);

    println!("{}", thin_line);

    // Frontend section
    println!(" Frontend");
    if let Some(fetch) = session.frontend_phases.get("fetch") {
        println!("   Fetch layers:      {:>8.1} ms", fetch);
    }
    if let Some(decompress) = session.frontend_phases.get("decompress") {
        println!("   Decompress:        {:>8.1} ms", decompress);
    }
    if let Some(render) = session.frontend_phases.get("render") {
        println!("   Render:            {:>8.1} ms", render);
    }
    println!("   --------------------------------");
    println!("   Subtotal:          {:>8.1} ms", frontend_subtotal);

    println!("{}", line);
    println!(
        " TOTAL:               {:>8.1} ms ({} layers)",
        total, backend.layer_count
    );
    println!("{}", line);
    println!();
}

/// Generate a simple session ID
pub fn generate_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();

    format!("bench_{:x}{:x}", now.as_secs(), now.subsec_nanos())
}

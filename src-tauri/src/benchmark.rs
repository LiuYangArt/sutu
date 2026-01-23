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
///
/// Returns the formatted report string when phase is "complete", for frontend console logging.
pub fn report_phase(session_id: &str, phase: &str, duration_ms: f64) -> Option<String> {
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
                return None;
            }
        }

        // Handle special phases
        match phase {
            "ipc_transfer" => {
                session.ipc_transfer_ms = Some(duration_ms);
                None
            }
            "complete" => {
                // Print the final report and get the formatted string
                let report = format_report(session);
                // Print to terminal
                println!("{}", report);
                // Clear session after report
                *session_guard = None;
                // Return for frontend console
                Some(report)
            }
            _ => {
                session
                    .frontend_phases
                    .insert(phase.to_string(), duration_ms);
                None
            }
        }
    } else {
        None
    }
}

/// Format the benchmark report as a string
fn format_report(session: &BenchmarkSession) -> String {
    use std::fmt::Write;

    let Some(backend) = &session.backend else {
        return String::new();
    };

    let frontend_subtotal: f64 = session.frontend_phases.values().sum();
    let ipc_ms = session.ipc_transfer_ms.unwrap_or(0.0);
    let total = backend.total_ms + ipc_ms + frontend_subtotal;

    let file_name = std::path::Path::new(&backend.file_path)
        .file_name()
        .map(|s| s.to_string_lossy())
        .unwrap_or_else(|| backend.file_path.as_str().into());

    const W: usize = 62;
    let line = "=".repeat(W);
    let thin = "-".repeat(W);

    let mut out = String::with_capacity(1024);
    let _ = writeln!(out);
    let _ = writeln!(out, "{line}");
    let _ = writeln!(
        out,
        "{:^W$}",
        format!("File Open Benchmark [{}]", backend.format.to_uppercase())
    );
    let _ = writeln!(out, "{line}");
    let _ = writeln!(out, " File: {file_name}");
    let _ = writeln!(out, "{thin}");

    // Backend
    let _ = writeln!(out, " Backend");
    let _ = writeln!(
        out,
        "   File read:         {:>8.1} ms",
        backend.file_read_ms
    );
    let _ = writeln!(
        out,
        "   Format parse:      {:>8.1} ms",
        backend.format_parse_ms
    );
    let _ = writeln!(
        out,
        "   Decode + Cache:    {:>8.1} ms",
        backend.decode_cache_ms
    );
    let _ = writeln!(out, "   --------------------------------");
    let _ = writeln!(out, "   Subtotal:          {:>8.1} ms", backend.total_ms);
    let _ = writeln!(out, "{thin}");

    // IPC
    let _ = writeln!(out, " IPC Transfer:        {:>8.1} ms", ipc_ms);
    let _ = writeln!(out, "{thin}");

    // Frontend
    let _ = writeln!(out, " Frontend");
    if let Some(v) = session.frontend_phases.get("fetch") {
        let _ = writeln!(out, "   Fetch layers:      {:>8.1} ms", v);
    }
    if let Some(v) = session.frontend_phases.get("decompress") {
        let _ = writeln!(out, "   Decompress:        {:>8.1} ms", v);
    }
    if let Some(v) = session.frontend_phases.get("render") {
        let _ = writeln!(out, "   Render:            {:>8.1} ms", v);
    }
    let _ = writeln!(out, "   --------------------------------");
    let _ = writeln!(out, "   Subtotal:          {:>8.1} ms", frontend_subtotal);
    let _ = writeln!(out, "{line}");
    let _ = writeln!(
        out,
        " TOTAL:               {:>8.1} ms ({} layers)",
        total, backend.layer_count
    );
    let _ = write!(out, "{line}");

    out
}

/// Generate a simple session ID
pub fn generate_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();

    format!("bench_{:x}{:x}", now.as_secs(), now.subsec_nanos())
}

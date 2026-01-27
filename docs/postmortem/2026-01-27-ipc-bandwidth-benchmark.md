# Postmortem: Tauri IPC Channel Bandwidth Limitation

**Date**: 2026-01-27
**Issue**: Rust -> Frontend IPC Channel throughput is capped at ~16 MB/s, insufficient for real-time high-res image transfer.

## Benchmark Results
We implemented a flood test (`ipc_benchmark_flood`) sending raw `Vec<u8>` data from a background Rust thread to the Frontend via `tauri::ipc::Channel`.

| Scenario | Payload Size | Count | Throughput |
|----------|--------------|-------|------------|
| Small Chunks | 64 KB | 1000 | ~16.48 MB/s |
| Large Chunks | 1 MB | 50 | ~16.29 MB/s |

## Analysis
1.  **Consistent Limit**: The throughput is remarkably consistent (~16 MB/s) regardless of chunk size (64KB vs 1MB). This suggests the bottleneck is linear with data size, pointing to data serialization or copy overhead rather than per-message overhead.
2.  **Serialization Overhead**: `tauri::ipc::Channel<Vec<u8>>` likely defaults to serializing byte vectors as JSON arrays (`[12, 255, 0, ...]`) rather than raw binary buffers in the current configuration. This introduces massive CPU overhead for string generation (Rust) and parsing (JS).
3.  **Bridge Limitations**: Even with binary protocols, the standard IPC bridge involves Base64 encoding or similar transforms if not strictly configured for binary transfer, which cuts effective bandwidth.

## Implications for Architecture
*   **Verdict**: The current IPC Channel implementation is **NOT suitable** for transferring large image buffers (e.g., 4K layer data, full-screen blits) in real-time.
*   **Acceptable Uses**:
    *   Control signals / Events.
    *   Input coordinates (small structs).
    *   Small metadata updates.
*   **Alternatives Required**:
    *   **Custom Protocol (`project://`)**: Already proven for static assets, but pull-only.
    *   **WebSocket**: Localhost server often bypasses WebView IPC overhead.
    *   **Shared Memory**: Not natively supported in WebViews without strict security headers (SharedArrayBuffer), but possible via specific Tauri plugins.

## Next Steps
1.  Investigate forcing raw binary transfer mode in Tauri v2 Channels.
2.  Prioritize **WebSocket** (already partially implemented in `bench_server`) or **HTTP Stream** for heavy data lift.

# Postmortem: Rust CPU Brush Latency & Disappearing Strokes

**Date:** 2026-01-27
**Status:** Investigation
**Feature:** Rust CPU Brush Engine (Optimization Phase)

## 1. Issue Description

After implementing performance optimizations (P0 Mask Caching, P2 Parallel Blending, P3 Dynamic Sync, P4 Wet Edge), the user reports:
1.  **High Latency:** Large brushes (e.g., 300px-500px) still exhibit significant lag.
2.  **Disappearing Strokes:** Completed strokes vanish from the canvas after lifting the pen.

## 2. Recent Changes

| Optimization | Description | Status | Impact |
| :--- | :--- | :--- | :--- |
| **P0 Mask Caching** | Cache Gaussian masks to avoid `exp()` | ✅ Implemented | CPU calc time < 5ms |
| **P2 Parallel Blending** | Use Rayon for multi-threaded blending | ✅ Implemented | Large brush calc speedup |
| **P3 Dynamic Sync** | Adjust IPC frequency (30fps) for large brushes | ✅ Implemented | Reduced IPC call count |
| **P4 Wet Edge** | LUT-based alpha mapping | ✅ Implemented | Functional |
| **Latency Breakdown** | Added `process_time` (Rust) and `queue_latency` (JS) metrics | ✅ Implemented | Enabled root cause isolation |

## 3. Root Cause Analysis

### 3.1 High Latency (Bottleneck Shifted)
The optimizations successfully reduced **Rust CPU Calculation** time to negligible levels. However, the bottleneck has shifted to **Data Transfer (IPC)**.

**Concrete Evidence (Benchmark Results):**
*   **Rust Process Time**: 0.42ms (Extremely fast, < 1ms)
*   **Queue Latency**: 11.2ms (Frontend processes messages quickly once received)
*   **Total Latency**: 950.2ms
*   **IPC Overhead**: ~938ms (The gap between Process End and Frontend Receive)

**Analysis:**
The system spends **99% of the time** just moving data from Rust to the Frontend.
*   **Data Volume**: A 600px diameter brush creates ~280,000 pixels per dirty rect. With 4 bytes/pixel (RGBA), that's **1.1MB per stamp**.
*   **IPC Congestion**: Tauri's Channel IPC likely uses base64 encoding or inefficient serialization for large binary payloads, causing massive blocking during transmission.
*   **P3 Strategy Backfire**: Accumulating data to reduce call count resulted in massive packets (>4MB) that clog the IPC pipe for nearly a second.

**Conclusion**: Pure CPU + Channel IPC approach hits a hard bandwidth ceiling for large brushes (>300px). No amount of Rust optimization can fix the IPC pipe width.

### 3.2 Disappearing Strokes
The stroke vanishing upon completion suggests a race condition or logic error in the lifecycle management (`endStroke`).

*   **Hypothesis 1: Smart Clear Race Condition**
    *   Rust's `begin_stroke` clears the *previous* stroke's dirty area from its persistent buffer.
    *   Frontend `endStroke` performs: (1) Wait for Rust, (2) Composite to Layer, (3) Clear Preview Buffer.
    *   If a **new stroke** starts before the **previous stroke** finishes compositing:
        1.  Stroke A ends. Frontend starts async composite.
        2.  Stroke B starts immediately.
        3.  Rust `begin_stroke` fires, clearing Stroke A's data from backend buffer (correct for backend).
        4.  **Critical**: Frontend `cpuBuffer` (preview) is shared. If Stroke B writes to it or clears it while Stroke A is trying to composite it to the layer, Stroke A might be lost or corrupted.
    *   *Mitigation check*: `useBrushRenderer` has `finishingPromiseRef` to lock `beginStroke` until `endStroke` completes. We need to verify if this lock is working or if the logic inside `rustReceiver` bypasses it.

*   **Hypothesis 2: IPC Data Loss**
    *   `rust_brush_end_stroke` returns the final dirty data.
    *   If this final packet is dropped or empty due to `P3` logic (e.g., `max_bytes` logic preventing flush?), the final part of the stroke (or all of it if it was one giant packet) never reaches the frontend.
    *   Frontend composites an incomplete/empty buffer.

## 4. Proposed Solutions

### 4.1 Fix Disappearing Strokes
1.  **Audit `endStroke` Flow**: Add logging to `RustBrushReceiver.ts` to confirm final data packet size and arrival.
2.  **Verify `finishingPromiseRef`**: Ensure strictly serial stroke processing.
3.  **Check Rust `end_stroke`**: Ensure `get_sync_data` is called *before* clearing any state that might prevent flushing.

### 4.2 Address Latency (Strategic Shift)
Since we are hitting IPC/JS limits:

1.  **Shared Memory (SharedArrayBuffer)**:
    *   Instead of copying `Vec<u8>` over IPC, allocate a shared buffer (Rust writes, JS reads).
    *   Requires secure context headers (COOP/COEP).
2.  **GPU Composition (WebGL/WebGPU)**:
    *   Upload texture once, apply dabs via shader. (This is the existing GPU backend path).
    *   *Recommendation*: For brushes > 300px, **force fallback to GPU backend** if available, or accept 15fps-like performance on CPU.
3.  **Optimize IPC Packet Size**:
    *   Compress data (LZ4)? JS decompression might cost more time.
    *   Downscale preview? High-DPI screens don't strictly need 1:1 preview during fast motion.

## 5. Immediate Next Steps
1.  **Debug Disappearing Strokes**: This is a critical functional bug.
    *   Log `end_stroke` data size in Rust and JS.
2.  **Tune P3 Thresholds**:
    *   4MB might be too aggressive for `putImageData`. Try capping at 1MB even for large brushes (force more frequent, smaller updates).
    *   It's better to have 60 updates of 500KB than 1 update of 30MB.

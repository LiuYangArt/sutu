# Rust 笔刷引擎回归方案 v2.2 (The Rust Brush Engine Revival)

> **v2.2 (Final)**: 整合了 Review 中关于 Benchmark 代码实现、WebGPU 内存对齐 (32-byte) 以及 Jitter/RTT 测量方法的详细建议。此版本已准备好进入编码阶段。

## 1. 背景与回顾

### 1.1 历史决策

在早期架构中，`Rust Engine -> IPC (JSON) -> Frontend` 方案因序列化开销和主线程阻塞被废弃。

### 1.2 新的契机

随着 **Tauri v2** 的发布（支持二进制 Channel）以及我们在文件 IO 优化中积累的经验，我们现在有机会构建一条**高效、零拷贝（Zero-copy）的二进制高速公路**。

## 2. 核心价值

1.  **性能**: 解锁 Rust SIMD 计算能力（用于湿边、涂抹、物理模拟）。
2.  **零 GC**: 消除 JS 端频繁创建临时对象引发的垃圾回收抖动。
3.  **输入稳定性**: 操作系统级输入直接在 Rust 消费，减少抖动。

## 3. 架构设计：流式混合引擎 (Streaming Hybrid Engine)

### 3.1 数据流图

```mermaid
graph LR
    Tablet[Digitizer] -->|Raw Events| RustInput[Rust Input Host]

    subgraph "Rust Backend (High Performance)"
        RustInput -->|Raw Points| RustEngine[Rust Brush Engine]
        RustEngine -->|SIMD/Math| Batcher[Batching System]
        Batcher -->|Flush Criteria| Transport[Transport Layer]
    end

    subgraph "The Tunnel (Benchmark Driven)"
        Transport -.->|Candidate A| IPC[Tauri v2 Channel]
        Transport -.->|Candidate B| WS[WebSocket (Localhost)]
        Transport -.->|Candidate C| Proto[Custom Protocol Stream]
    end

    subgraph "Frontend (WebGPU)"
        IPC & WS & Proto -->|Binary Bytes| Receiver[Receiver Worker]
        Receiver -->|Ring Buffer| Queue[Dab Queue]
        Queue -->|Float32Array| GPU[WebGPU Stroke Buffer]
    end
```

### 3.2 关键技术优化

#### A. 紧凑数据结构 (32-byte Alignment)

为了最大化传输效率并完美匹配 **WebGPU (WGSL)** 的 `vec4` 对齐要求，我们定义如下结构：

```rust
#[repr(C)]
#[derive(Clone, Copy, Debug)]
// 建议使用 bytemuck 库实现安全的 cast
pub struct DabPacket {
    // Group 1: Position & Size
    pub x: f32,            // 4 bytes
    pub y: f32,            // 4 bytes
    pub size: f32,         // 4 bytes
    pub pressure: f32,     // 4 bytes (用于 shader 动态计算 opacity 或其他)

    // Group 2: Appearance & Meta
    pub rotation: f32,     // 4 bytes (Radians)
    pub tex_index: u32,    // 4 bytes
    pub opacity: f32,      // 4 bytes
    pub flags: u32,        // 4 bytes (e.g. wet_edge, eraser, etc.) -- Padding to 32
}
// Total: 32 bytes (2 * vec4<f32>)
```

#### B. 批量发送策略 (Batching Strategy)

单点发送会导致过多的 Context Switch。

- **缓冲区**: `Vec<DabPacket>`
- **Flush 条件 A**: 缓冲区满 N 个点（如 16 个）。
- **Flush 条件 B**: 距离上次 Flush 超过 T 毫秒（如 4ms，对应 240Hz）。

#### C. 前端解耦 (Decoupling)

1. **Worker**: `channel.onmessage` -> `RingBuffer.write(bytes)` (仅内存拷贝)。
2. **Main Loop**: `requestAnimationFrame` -> `RingBuffer.readAll()` -> `device.queue.writeBuffer`。

## 4. 传输协议基准测试计划 (Benchmark Plan)

目标：实测选出**低延迟**且**低抖动 (Jitter)** 的方案。

### 4.1 测试方法：关注 Jitter 与 RTT

**为何不直接用单向延迟？**
由于 Rust `Instant` 和 JS `performance.now()` 时钟源不同，单向相减无意义。我们采用：

1.  **Inter-arrival Jitter (接收间隔抖动)**: 不需要时钟同步。前端记录 `Time_N - Time_N-1`。如果发送频率是 240Hz (4.16ms)，则 Jitter = `| (T_N - T_N-1) - 4.16ms |`。
2.  **Throughput (吞吐量)**: 单位时间接收包数量。

### 4.2 核心代码实现 (Tauri v2 Channel)

#### Rust 端 (`src-tauri/src/bench.rs`)

```rust
use tauri::ipc::Channel;
use std::thread;
use std::time::{Duration, Instant};

#[tauri::command]
pub fn start_benchmark(on_event: Channel<Vec<u8>>, freq_hz: u64, duration_ms: u64) {
    thread::spawn(move || {
        let interval = Duration::from_micros(1_000_000 / freq_hz);
        let start = Instant::now();
        let mut seq = 0u32;

        // 预分配 Buffer (模拟 Batch)
        let batch_size = 10;

        while start.elapsed().as_millis() < duration_ms as u128 {
            let loop_start = Instant::now();

            // 构造 Batch 数据
            let mut buffer = Vec::with_capacity(32 * batch_size);
            for _ in 0..batch_size {
                // ... write 32 bytes mock data ...
            }

            // 发送
            if on_event.send(buffer).is_err() { break; }

            // Smart Sleep
            let work_time = loop_start.elapsed();
            if work_time < interval {
                thread::sleep(interval - work_time);
            }
        }
    });
}
```

#### 前端端 (`LatencyTest.ts`)

```typescript
export async function runBenchmark() {
  const channel = new Channel<Uint8Array>();
  let lastTime = performance.now();
  const jitters: number[] = [];

  channel.onmessage = (msg) => {
    const now = performance.now();
    const delta = now - lastTime;
    lastTime = now;

    // 记录抖动
    jitters.push(delta);
  };

  await invoke('start_benchmark', {
    onEvent: channel,
    freqHz: 240,
    durationMs: 5000,
  });

  // 分析结果 (Avg Jitter, Max Jitter)
  // 如果 Avg Jitter < 1ms, 则方案通过。
}
```

## 5. 实施路线图 (Roadmap)

1.  **Phase 1: 协议选型 (本周)**
    - 运行上述 Benchmark 代码。
    - 优先测试 **Tauri v2 Channel**。若 Jitter > 2ms 或出现明显尖峰，加入 WebSocket 对比测试。
2.  **Phase 2: 引擎移植**
    - 实现 Rust 端 `StrokeAccumulator` 和 `DabGenerator`。
    - 采用 bytemuck 实现 `DabPacket` 的 Zero-copy 序列化。
3.  **Phase 3: 前端对接**
    - 实现 Ring Buffer 和 WebGPU 批量上传。
4.  **Phase 4: 验证**
    - 使用 Input Recorder 回放真实笔迹，验证渲染一致性。

## 6. 结论

方案已升级至 v2.2，吸纳了基于实测数据 (Data-Driven) 的决策逻辑。通过 **32-byte 对齐** 优化 WebGPU 性能，通过 **Batching + Jitter 监控** 确保传输稳定性，该方案已具备极高的落地置信度。

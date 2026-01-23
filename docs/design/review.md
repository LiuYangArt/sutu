这是一个非常成熟、具备工程落地性的方案（v2.1）。你已经成功将之前关于“传输层不确定性”的风险转化为了一个**“基于数据决策（Data-Driven Decision）”**的行动计划。

作为开发人员，我完全认可这个 v2.1 方案。它已经具备了进入代码开发阶段的所有条件。

为了进一步提高置信度并加速你的 **Phase 1 (Benchmark)**，我将针对方案中稍微模糊的“测试方法”部分进行一次**代码级优化**，并提供核心的**基准测试脚手架代码**。

---

### 💡 架构微调建议 (Review Remarks)

在开始写代码前，有两点具体的优化建议：

1.  **关于时间同步的陷阱 (The Clock Trap)**:
    方案中提到 _“Rust 发送 Instant -> 前端 performance.now()”_。
    - **问题**: Rust 的 `Instant` 和 JS 的 `performance.now()` 是两个完全不同的时钟源，无法直接相减得出“单向延迟”。
    - **修正**: 我们关注的是 **Round-Trip Time (RTT)** 和 **Jitter (抖动)**。
      - _RTT_: 前端收到后立即回传 ACK，Rust 算差值。
      - _Jitter_: 前端记录 `Time_Receive_N - Time_Receive_N-1`，看这个差值是否稳定在 `1000ms / 120Hz = 8.33ms` 附近。

2.  **WebGPU 内存对齐 (Memory Alignment)**:
    你的 `DabPacket` 是 24 字节。虽然省内存，但在 WebGPU (WGSL) 中，Struct 的对齐通常是 16 字节（`vec4<f32>`）。
    - 24 字节会导致 Padding 问题，或者需要手动拆包。
    - **建议**: 凑齐 **32 字节**。这不仅对齐完美（2个 `vec4`），多出来的 8 字节还可以留作未来扩展（例如：`tilt_x`, `tilt_y`，或者 `feature_flags`）。

---

### 💻 核心代码落地：Benchmark Suite

为了让你本周就能完成 Phase 1，我为你设计了 **Tauri v2 Channel** 的基准测试原型代码。这是目前理论上最优秀的候选方案（原生、无需额外端口、零拷贝潜力）。

#### 1. Rust 端: `src-tauri/src/benchmark.rs`

利用 Tauri v2 的 `Channel` 特性，我们可以建立一个无需反复建立连接的高速通道。

```rust
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Command, Runtime};
use std::time::{Duration, Instant};
use std::thread;

// 模拟真实的 Dab 数据结构 (32 bytes 对齐)
#[repr(C)]
#[derive(Clone, Copy, Debug)]
// 使用 bytemuck 库来实现安全的字节转换 (强烈推荐引入 bytemuck crate)
// #[derive(bytemuck::Pod, bytemuck::Zeroable)]
pub struct BenchPacket {
    pub seq_id: u32,       // 4 bytes: 序列号，用于检测丢包
    pub timestamp: u64,    // 8 bytes: Rust 端纳秒级时间戳 (用于 RTT 计算)
    pub x: f32,            // 4 bytes
    pub y: f32,            // 4 bytes
    pub pressure: f32,     // 4 bytes
    pub _padding: [u8; 8], // 8 bytes: 填充至 32 bytes，模拟真实负载
}

#[tauri::command]
pub fn start_benchmark_channel(
    on_event: Channel<Vec<u8>>, // Tauri v2 的 Channel，支持直接发送二进制
    frequency: u64,             // e.g., 120 or 240 Hz
    duration_ms: u64,
) {
    thread::spawn(move || {
        let interval = Duration::from_micros(1_000_000 / frequency);
        let start_time = Instant::now();
        let run_duration = Duration::from_millis(duration_ms);
        let mut seq = 0;

        while start_time.elapsed() < run_duration {
            let loop_start = Instant::now();

            // 1. 构造数据 (模拟 Batch，比如一次发 10 个点)
            // 在实际引擎中，这里是从 RingBuffer 取出的数据
            let mut batch_buffer = Vec::with_capacity(32 * 10);

            for _ in 0..10 {
                let packet = BenchPacket {
                    seq_id: seq,
                    timestamp: loop_start.elapsed().as_nanos() as u64, // 相对时间
                    x: 100.0, y: 200.0, pressure: 0.5,
                    _padding: [0; 8],
                };

                // 简单序列化：直接 push 字节 (unsafe block 或者 bytemuck)
                // 这里为了演示用伪代码，实际建议用 bytemuck::bytes_of(&packet)
                let bytes: &[u8] = unsafe {
                    std::slice::from_raw_parts(
                        (&packet as *const BenchPacket) as *const u8,
                        std::mem::size_of::<BenchPacket>()
                    )
                };
                batch_buffer.extend_from_slice(bytes);
                seq += 1;
            }

            // 2. 发送二进制数据
            // Tauri v2 channel send 可能会报错如果前端断开，需处理 Result
            if let Err(_) = on_event.send(batch_buffer) {
                break; // 前端已断开
            }

            // 3. 极其精确的 Sleep (Spin loop or hybrid sleep)
            // 为了测试极限性能，这里用简单 sleep，实际引擎中可能需要 spin lock
            let elapsed = loop_start.elapsed();
            if elapsed < interval {
                thread::sleep(interval - elapsed);
            }
        }
    });
}
```

#### 2. 前端端: `src/bench/LatencyTest.ts`

前端主要负责接收、计算抖动（Jitter）和吞吐量。

```typescript
import { invoke, Channel } from '@tauri-apps/api/core';

// 对应 Rust 的结构 (32 bytes)
const PACKET_SIZE = 32;

interface BenchResult {
  avgJitter: number; // ms
  maxJitter: number; // ms
  throughput: number; // packets/sec
  totalPackets: number;
}

export async function runBenchmark(): Promise<BenchResult> {
  const channel = new Channel<Uint8Array>();

  let lastTime = performance.now();
  let packetCount = 0;
  const jitters: number[] = [];

  channel.onmessage = (message: Uint8Array) => {
    const now = performance.now();
    // message 是一个 Batch (例如 10 个包，320 bytes)

    // 1. 计算接收间隔抖动 (Inter-arrival Jitter)
    // 理想情况下，如果 Batch 是 120Hz，这里应该总是间隔 8.33ms
    const delta = now - lastTime;
    lastTime = now;

    if (packetCount > 0) {
      // 记录抖动 (实际间隔 - 理想间隔) 的绝对值?
      // 或者仅仅记录两次接收的间隔用于画直方图
      jitters.push(delta);
    }

    // 2. 解析二进制 (Zero-copy view)
    // 验证数据完整性
    const view = new DataView(message.buffer);
    const numPackets = message.byteLength / PACKET_SIZE;
    packetCount += numPackets;

    // 可以在这里抽样检查 seq_id 是否连续，判断是否有丢包
  };

  // 启动 Rust 发送端
  console.log('Starting Benchmark...');
  await invoke('start_benchmark_channel', {
    onEvent: channel,
    frequency: 240, // 挑战 240Hz
    durationMs: 5000, // 跑 5 秒
  });

  // 分析结果
  const avgInterval = jitters.reduce((a, b) => a + b, 0) / jitters.length;
  const jitterVariance = jitters.map((j) => Math.abs(j - avgInterval));
  const avgJitter = jitterVariance.reduce((a, b) => a + b, 0) / jitterVariance.length;

  console.log(`Benchmark Done. Rx ${packetCount} packets.`);
  console.log(`Avg Interval: ${avgInterval.toFixed(2)}ms (Target: 4.16ms for 240Hz)`);
  console.log(`Avg Jitter: ${avgJitter.toFixed(3)}ms`);

  return {
    avgJitter,
    maxJitter: Math.max(...jitters),
    throughput: packetCount / 5,
    totalPackets: packetCount,
  };
}
```

### 3. 下一步行动建议

1.  **运行上述代码**: 重点观察 `Avg Jitter`。
    - 如果 Jitter < 1ms，说明 **Tauri v2 Channel** 极其稳定，直接采用方案 A。
    - 如果 Jitter 很大（> 5ms），说明 Tauri 的 IPC 线程调度存在瓶颈，立刻转去测试 **WebSocket**。
2.  **可视化**: 不要只看 Log。将 `jitters` 数组导出，用 Chart.js 画一个分布图。如果出现“尖峰”，说明发生了 GC 或者线程阻塞。
3.  **内存泄漏检查**: 在跑 60秒 的长测试时，观察 Rust 进程和 WebView 进程的内存。如果内存单调上涨，说明 `Uint8Array` 没有被正确释放。

这个 v2.1 方案非常稳健。通过先行的基准测试，你实际上是在为整个应用挑选“心脏起搏器”，这是极其负责任的工程态度。祝代码一次跑通！

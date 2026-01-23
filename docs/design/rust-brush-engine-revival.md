# Rust 笔刷引擎回归方案 (The Rust Brush Engine Revival)

## 1. 背景与回顾

### 1.1 历史决策

在项目的早期架构设计中，我们尝试过 `Input (Rust) -> Process (Rust) -> IPC -> Render (Frontend)` 的方案。
当时被废弃并降级为 "Frontend-First" 架构的主要原因是：

1.  **IPC 序列化开销**: 如果通过标准的 Tauri Event 发送 JSON 数据，由于 Base64 编码和 JSON 序列化/反序列化，导致了严重的 CPU 消耗和延迟。
2.  **主线程阻塞**: 大量的 IPC 消息涌入 JS 主线程，导致事件循环拥堵，渲染帧率下降。
3.  **延迟**: 无法满足 <12ms 的端到端延迟目标。

### 1.2 新的契机

近期在 `docs/design/file-io-optimization.md` 和 `docs/design/abr-loading-optimization.md` 中，我们成功实现了基于 **自定义协议 (`project://`)** 的高效二进制传输机制。
这为我们重新引入 Rust 笔刷引擎提供了关键的基础设施：**高速的二进制数据通道**。

## 2. 核心价值：为什么我们需要 Rust 引擎？

尽管前端 TS 引擎已经能工作，但在某些场景下仍然存在瓶颈：

1.  **复杂计算性能**: 对于 "Wet Edges" (湿边)、"Smudge" (涂抹) 等需要大量像素级读写或复杂数学运算（如流体模拟、贝塞尔高阶拟合）的效果，JS (即便 V8 优化) 仍不如 Rust SIMD 高效。
2.  **GC 压力**: TS 引擎在高频笔触下会创建大量临时对象 (Points, Dabs context)，导致 GC 抖动。Rust 可以做到零 GC。
3.  **输入稳定性**: 操作系统级输入 (`octotablet`) 直接在 Rust 消费，避免了 `Rust -> IPC -> JS` 这第一层转发的抖动。
4.  **并行化潜力**: Rust 引擎可以无缝利用 `Rayon` 进行多线程计算（例如同时计算粒子系统的物理模拟）。

## 3. 架构设计：基于流式传输的 Hybrid Engine 2.0

我们将不再使用简单的 "Tauri Events" 来推送笔刷数据，而是建立一条 **独占的二进制笔刷流 (Binary Brush Stream)**。

### 3.1 数据流图

```mermaid
graph LR
    Tablet[Digitizer] -->|Raw Events| RustInput[Rust Input Host]

    subgraph "Rust Backend (High Performance)"
        RustInput -->|Raw Points| RustEngine[Rust Brush Engine]
        RustEngine -->|SIMD/Math| Dabs[Dab Buffer (Ring)]
    end

    subgraph "Transport (The Tunnel)"
        Dabs -->|Streaming| CustomProto[project://brush-stream]
    end

    subgraph "Frontend (WebGPU)"
        CustomProto -->|ReadableStream| JSReader[Stream Reader (Worker)]
        JSReader -->|Float32Array| GPU[WebGPU Stroke Buffer]
    end
```

### 3.2 关键技术点

#### A. 自定义协议流 (The Stream)

不同于文件加载的 "一次性请求"，笔刷流是一个 **长连接 (Long-lived Connection)**。

1.  **前端**: 发起请求 `const response = await fetch('project://stream/brush-events', { method: 'POST' });`
2.  **后端**:
    - 接收请求后，**不立即关闭连接**。
    - 持有一个 `mpsc::Receiver` 或 `RingBuffer` 读取端。
    - 当 Rust 引擎生成新的 Dabs 时，通过 HTTP `Chunked Transfer Encoding` (或 Tauri 的流式响应接口) 将二进制数据写入 Response Body。
3.  **传输格式**:
    - 纯二进制结构体 (Packed Setup)。
    - **不进行 JSON 序列化**。
    - **不进行 Base64 编码**。

**数据包结构 (示例)**:

```rust
#[repr(C)] // 保证内存布局一致
struct DabPacket {
    x: f32,
    y: f32,
    size: f32,
    opacity: f32, // 0.0-1.0
    rotation: f32, // Radians
    tex_index: u32,
    // total 24 bytes per dab
}
```

#### B. 共享内存 (备选方案)

如果 `project://` 流式传输存在 HTTP 协议头开销或 Tauri 实现限制，备选方案是使用 **Shared Memory (Mapped Buffer)**。
_(注意：Tauri v2 本身不直接暴露 SharedBuffer 给 Webview，通常需要 native 插件支持，因此优先尝试 Stream 方案，若延迟不达标则回退到 Binary Payload Event)_。

**Tauri 2.0 Binary Channel 优化**:
Tauri v2 的 IPC (`Event`) 已经支持 `Uint8Array` 直接透传（Zero-copy 优化）。如果流式 HTTP 过于复杂，我们可以直接使用 `emit('brush-data', bytes)`。现在的关键区别是我们发送的是 **Compact Binary Bytes** 而不是 JSON 对象。

### 3.3 混合模式策略

我们将保留 JS 引擎作为 "即时反馈" 或 "轻量级" 选项吗？
建议策略：**完全切换 (Full Switch)**。
为了维护简便性，一旦 Rust 引擎就绪，除了极简单的 UI 交互（如光标跟随），实际的笔触生成逻辑应完全下沉至 Rust。

## 4. 详细设计方案

### 4.1 Rust 端 (`src-tauri/src/brush_engine/`)

1.  **StrokeAccumulator**: 接收 RawInput，累积并进行贝塞尔插值。
2.  **Dynamics**: 应用压力曲线、倾斜映射（复用现有逻辑，但移至 Rust）。
3.  **Streamer**:
    - 维护一个 `Vec<u8>` 缓冲区。
    - 达到阈值（如 10个 dabs 或 5ms 超时）即 flush 到传输通道。

```rust
// 伪代码
fn process_input(input: RawInputPoint) {
    let dabs = engine.compute_dabs(input);
    let bytes = dabs.to_bytes(); // Direct memory copy
    stream_channel.send(bytes);
}

// 协议处理器
fn brush_stream_handler(req: Request) -> Response {
    let (tx, body) = StreamBody::new();
    GLOBAL_STREAM_TX.set(tx);
    Response::new(body)
}
```

### 4.2 前端端 (`src/brush/RemoteEngine.ts`)

1.  **Stream Reader**:
    ```typescript
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // value is Uint8Array
      // 直接创建 Float32Array 视图，无需解析
      const dabs = new Float32Array(value.buffer);
      gpuRenderer.upload(dabs);
    }
    ```
2.  **Web Worker**: 建议将 Reader 放入 Web Worker，避免主线程任何可能的 IO 阻塞。

## 5. 预期收益与风险

### 收益

1.  **性能**: CPU 占用预期下降 40% (去除 JS 逻辑和 JSON 序列化)。
2.  **功能上限**: 解锁 Rust 生态的数学库 (nalgebra, parry) 用于实现高级笔刷物理效果。
3.  **代码复用**: 笔刷逻辑可以与未来可能的 iPad/Android 原生版本共享 (通过 Rust)。

### 风险

1.  **实现复杂度**: 调试 "二进制流" 比调试 JSON 困难得多。需要开发专用的调试工具 (Hex Viewer / Visualizer)。
2.  **Tauri 限制**: 需确认 Tauri 的 Custom Protocol Response 是否完美支持无限长度的 Chunked Stream 且不缓存导致内存泄漏。

## 6. 实施路线图

1.  **原型验证 (PoC)**:
    - 编写一个简单的 `project://stream/test`，后端死循环发送计数器字节。
    - 前端读取并打印，测量延迟和频率。
2.  **Rust 引擎移植**:
    - 将 `BrushStamper.ts` 中的 间距/抖动 逻辑移植回 Rust。
3.  **协议对接**:
    - 连接 Input -> Engine -> Stream。
4.  **前端渲染对接**:
    - 修改 `WebGPURenderer` 接受 `Float32Array` 形式的 Dab 列表。

## 7. 结论

利用现有的 `project://` 通道技术，**Rust 笔刷引擎的回归是完全可行的**，并且是迈向 "Professional Grade" 性能的关键一步。它消除了 JS 单线程瓶颈，让 PaintBoard 能够承载更复杂的笔刷算法。

# Rust 笔刷引擎回归方案 v2.1 (The Rust Brush Engine Revival)

> **基于 Review 反馈的优化版本**: 针对原方案中 `project://` 流式传输可能存在的延迟风险，本方案引入了更稳健的传输层候选项，并制定了基准测试计划。

## 1. 背景与回顾

### 1.1 历史决策

在项目的早期架构设计中，我们尝试过 `Input (Rust) -> Process (Rust) -> IPC -> Render (Frontend)` 的方案。
当时被废弃并降级为 "Frontend-First" 架构的主要原因是：

1.  **IPC 序列化开销**: 标准 Tauri Event 发送 JSON 数据会导致严重的 CPU 消耗（序列化/Base64）和延迟。
2.  **主线程阻塞**: 大量消息涌入 JS 主线程，导致事件循环拥堵。

### 1.2 新的契机

随着 **Tauri v2** 的发布以及我们在文件 IO 优化中积累的**二进制传输**经验，我们现在有机会构建一条**高效、零拷贝（或近零拷贝）的二进制高速公路**，从而重新引入 Rust 笔刷引擎。

## 2. 核心价值

1.  **性能**: 解锁 Rust SIMD 计算能力（用于湿边、涂抹、物理模拟）。
2.  **零 GC**: 消除 JS 端频繁创建临时对象引发的垃圾回收抖动。
3.  **输入稳定性**: 操作系统级输入直接在 Rust 消费，减少抖动。

## 3. 架构设计 v2.1：流式混合引擎 (Streaming Hybrid Engine)

我们不再依赖单一的 `project://` 请求响应模式，而是构建一个**真正的流式管线**。

### 3.1 数据流图

```mermaid
graph LR
    Tablet[Digitizer] -->|Raw Events| RustInput[Rust Input Host]

    subgraph "Rust Backend (High Performance)"
        RustInput -->|Raw Points| RustEngine[Rust Brush Engine]
        RustEngine -->|SIMD/Math| Batcher[Batching System]
        Batcher -->|Flush Criteria| Transport[Transport Layer]
    end

    subgraph "The Tunnel (Pluggable)"
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

#### A. 紧凑数据结构 (Packed Data)

为了最大化传输效率并方便 WebGPU 直接读取（对齐 `vec4`），我们定义紧凑的二进制结构：

```rust
#[repr(C)]
struct DabPacket {
    x: f32,       // 4 bytes
    y: f32,       // 4 bytes
    size: f32,    // 4 bytes
    // 压缩字段：将 rotation 和 opacity 压缩为 u16
    rotation: u16, // 2 bytes (0-65535 映射 0-2PI)
    opacity: u16,  // 2 bytes (0-65535 映射 0.0-1.0)
    tex_index: u32,// 4 bytes
    padding: u32   // 4 bytes (凑齐 24 bytes 或 32 bytes 对齐)
}
```

#### B. 批量发送策略 (Batching Strategy)

单点发送会导致过多的 Context Switch。我们需要一个智能的 Batcher：

- **缓冲区**: `Vec<DabPacket>`
- **Flush 条件 A**: 缓冲区满 N 个点（如 16 个）。
- **Flush 条件 B**: 距离上次 Flush 超过 T 毫秒（如 4ms，对应 240Hz）。

#### C. 前端解耦 (Decoupling)

前端接收网络数据和渲染必须解耦，使用 **Ring Buffer** 模式：

1. **Worker**: 收到二进制包 -> 写入 Ring Buffer (仅内存拷贝)。
2. **Main Loop**: `requestAnimationFrame` -> 从 Ring Buffer 读取当前所有可用数据 -> 一次性上传 GPU。

## 4. 传输协议基准测试计划 (Benchmark Plan)

鉴于 Review 中指出的 `project://` 流式传输风险（浏览器缓冲、线头阻塞），我们需要通过实测选出最佳方案。

### 4.1 候选协议

| 协议                          | 描述                                         | 优势                                         | 劣势/风险                                           |
| :---------------------------- | :------------------------------------------- | :------------------------------------------- | :-------------------------------------------------- |
| **A. Tauri v2 IPC Channel**   | 使用 Tauri `Event` 或 `Channel` 发送 `Bytes` | 原生集成，无需额外端口，v2 有 Zero-copy 优化 | 仍经过 IPC 层，可能受限于消息队列长度               |
| **B. WebSocket (Local)**      | Rust 启动 `ws://127.0.0.1` 服务              | 极其成熟，低延迟，浏览器原生支持二进制帧     | 需要管理额外端口，防火墙/权限隐患                   |
| **C. Custom Protocol Stream** | `fetch('project://stream')`                  | 复用现有基础设施，无跨域问题                 | **高风险**: 浏览器 fetch 缓冲不可控，可能导致微卡顿 |

### 4.2 测试方法

**目标**: 模拟高频笔刷输入，测量“端到端延迟”和“传输抖动”。

**测试工具**: 开发一个独立的 Benchmark 模块（不依赖绘图逻辑）。

**测试步骤**:

1.  **发送端 (Rust)**:
    - 以 **120Hz** 和 **240Hz** 的频率发送固定大小的数据包（模拟 Dab Batch）。
    - 每个数据包包含发送时的**高精度时间戳 (Rust Instant)**。
2.  **接收端 (Frontend)**:
    - 收到数据包后，记录当前时间 (`performance.now()`)。
    - 计算 **Delta** (需先进行时钟同步，或仅计算 Round-Trip Time)。
    - **更佳方案 (RTT)**: 前端收到后立即回传一个 ACK 包，Rust 端计算 RTT。

**关键指标**:

1.  **Average RTT**: 平均往返时延 (越低越好，目标 < 4ms)。
2.  **Jitter (Std Dev)**: 时延标准差 (越小越好，决定是否跟手)。
3.  **Max Latency**: 最大时延 (检测长尾卡顿)。
4.  **Throughput**: 极限吞吐量 (MB/s)。

### 4.3 实施计划

1.  **Step 1: 搭建 Benchmark 环境**
    - 创建 `src-tauri/src/bench/` 模块。
    - 实现三种传输方式的最小化 Demo。
2.  **Step 2: 运行测试**
    - 在不同配置机器上运行。
    - 特别关注低端机表现。
3.  **Step 3: 选型**
    - 根据数据选择最终方案（预计 WebSocket 或 Tauri IPC 胜出）。

## 5. 实施路线图 (Roadmap)

1.  **Phase 1: 协议选型 (Benchmark)** [本周]
    - 完成上述 Benchmark。
    - 确定最终通信管道。
2.  **Phase 2: 引擎移植 (Rust)**
    - 移植间距计算 (Spacing)、抖动 (Jitter)、动态参数 (Dynamics)。
    - 实现 Dab 生成逻辑。
3.  **Phase 3: 前端对接**
    - 实现 Worker 接收器 + Ring Buffer。
    - 对接 WebGPU 渲染接口。
4.  **Phase 4: 验证**
    - 启用 Input Recorder，回放真实绘画轨迹，对比新旧引擎渲染结果。

## 6. 结论

通过引入基准测试和更稳健的协议选项，我们不仅保留了 Rust 引擎的高性能潜力，还规避了单一技术选型的风险。这将是 PaintBoard 迈向专业级性能（<12ms 延迟，无卡顿）的确切路径。

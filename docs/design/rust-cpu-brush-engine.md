# Rust CPU 笔刷引擎设计方案

> **状态**: 📝 规划中 (v1.3 - 已整合深度技术评审)
> **前置条件**: Tauri v2 Channel IPC 测试通过 (Avg Jitter < 0.4ms)
> **目标**: 替代 TypeScript CPU 笔刷，提供高性能 CPU 渲染路径
> **置信度评估**: 70% (技术可行 85%, 性能目标 65%, 内存目标 65%)

## 1. 背景与动机

### 1.1 当前架构问题

| 渲染引擎               | 状态        | 问题                                  |
| ---------------------- | ----------- | ------------------------------------- |
| **GPU Compute Shader** | ✅ 主力     | 随机闪烁 bug，极难调试                |
| **TypeScript CPU**     | ✅ Fallback | 大笔刷 (200px+) 性能差，卡顿          |
| **Rust CPU (旧)**      | ❌ 废弃     | IPC 开销过大 (已通过 v2 Channel 解决) |

### 1.2 新机遇

1. **Tauri v2 Channel** 测试结果优秀：
   - Avg Jitter: **0.386ms** (目标 < 1ms ✅)
   - Max Jitter: 2.167ms
   - Packet Loss: 0

2. **现有 Rust 代码可复用**：
   - `brush/soft_dab.rs`: **SIMD AVX 优化的 Gaussian Mask 生成** ✅
   - `brush/blend.rs`: **多种混合模式实现** ✅
   - `brush/stroke_buffer.rs`: **Stroke Buffer 结构** ✅
   - `brush/stamper.rs`: **Dab 间距计算** ✅

## 2. 设计目标

| 指标           | 目标        | 参考           |
| -------------- | ----------- | -------------- |
| 500px dab 渲染 | < 5ms       | TS 当前约 10ms |
| IPC 传输延迟   | < 1ms       | 已验证 0.4ms   |
| 首个 dab 延迟  | < 8ms       | 用户感知阈值   |
| 内存占用       | < 80MB 上限 | Stroke Buffer  |
| 提升倍数       | ≥ 2x        | 保守估计       |

> **注意**: 性能目标已根据深度技术评审调整，提升倍数目标从 3x 降为 2x。

## 3. 架构设计

### 3.1 核心思路

**Rust 端维护 Stroke Layer（单笔画临时层）**，执行所有像素级计算（Mask + Blending）。仅在需要时通过 Channel 传输 dirty rect 到前端进行 Canvas 显示。

**关键语义澄清**：

- `buffer` = **Stroke Layer**（单笔画临时层），不是最终图层
- `begin_stroke()` 清空 buffer 是正确的——清空的是临时 stroke buffer
- `end_stroke()` 时，前端负责将 stroke layer 合成到目标图层

### 3.2 数据流

```
┌──────────────────────────────────────────────────────────────────┐
│                        Rust Backend                               │
│                                                                   │
│  ┌─────────────┐    ┌──────────────────┐    ┌─────────────────┐  │
│  │ Input Event │───►│ BrushStamper     │───►│ StreamingEngine │  │
│  │ (x,y,p)     │    │ (existing code)  │    │ (Stroke Layer)  │  │
│  │             │    │ - Spacing        │    │                 │  │
│  │             │    │ - Interpolation  │    │  ┌───────────┐  │  │
│  └─────────────┘    └──────────────────┘    │  │ SIMD Mask │  │  │
│                                              │  │ + Cache   │  │  │
│                                              │  └─────┬─────┘  │  │
│                                              │        ▼        │  │
│                                              │  ┌───────────┐  │  │
│                                              │  │Alpha Blend│  │  │
│                                              │  └─────┬─────┘  │  │
│                                              └────────┼────────┘  │
│                                                       │           │
│  ┌────────────────────────────────────────────────────▼────────┐  │
│  │ SyncTrigger: N dabs OR T_ms OR MAX_BYTES                    │  │
│  │ Output: scratch buffer + clone (Tauri 需要所有权)            │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────┬───────────────────────────┘
                                        │ Tauri v2 Channel (Binary)
                                        │ Avg Latency: ~0.4ms
                                        ▼
┌───────────────────────────────────────────────────────────────────┐
│                        Frontend                                    │
│                                                                   │
│  ┌─────────────────┐    ┌─────────────────┐    ┌───────────────┐  │
│  │ Channel.onMessage│───►│ Message Queue  │───►│ RAF Batch      │  │
│  │ (Uint8Array)    │    │ (背压检测)      │    │ putImageData  │  │
│  └─────────────────┘    └─────────────────┘    └───────────────┘  │
│                                                                   │
│  onStrokeEnd: Composite stroke layer → target layer → history     │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 3.3 与 GPU 引擎的关系

```
用户选择渲染引擎
        │
        ├──► GPU Compute Shader (默认，高性能)
        │         │
        │         ▼ 遇到问题时
        │
        └──► Rust CPU Engine (Fallback，稳定可靠)
                  │
                  ▼ Rust 引擎失败时 (自动降级)
              TypeScript CPU (最后手段)
```

## 4. 特性差距分析

### 4.1 TypeScript 实现已有特性 vs Rust 支持

| 特性                            | TS 实现                  | Rust 现有代码           | 优先级 | 说明          |
| ------------------------------- | ------------------------ | ----------------------- | ------ | ------------- |
| **Gaussian Mask (erf-based)**   | ✅                       | ✅ `soft_dab.rs`        | -      | 已有          |
| **Ellipse (roundness + angle)** | ✅                       | ✅ `GaussParams::ycoef` | -      | 已有          |
| **Flow/Opacity 分离**           | ✅                       | ✅ `render_soft_dab`    | -      | 已有          |
| **Mask Cache (参数容差)**       | ✅ 2% size容差           | ❌                      | 🔴 P0  | 性能关键      |
| **Hard Brush 快速路径**         | ✅ `stampHardBrush()`    | ❌                      | 🔴 P0  | 跳过 Gaussian |
| **Alpha Darken 混合**           | ✅ Krita-style           | ⚠️ Normal only          | 🟡 P1  | 需调整        |
| **Wet Edge (LUT-based)**        | ✅ `wetEdgeLut`          | ❌                      | 🟡 P1  | LUT 实现      |
| **Texture Brush (ABR)**         | ✅ `textureMaskCache.ts` | ❌                      | 🟡 P1  | 从缓存加载    |
| **Flip X/Y (Shape Dynamics)**   | ✅ 纹理笔刷用            | ❌                      | 🟢 P2  | 低优先级      |

## 5. Review 反馈与修正 (v1.3)

### 5.1 关键修正

| 问题                | v1.2 设计                     | v1.3 修正                    | 理由                                        |
| ------------------- | ----------------------------- | ---------------------------- | ------------------------------------------- |
| **输出缓冲策略**    | 双缓冲 + `mem::take` 无 clone | **Scratch buffer + clone**   | Tauri Channel 消耗 Vec 所有权，无法回收复用 |
| **会话淘汰策略**    | 声称 LRU                      | **FIFO**（按创建顺序）       | VecDeque 只 push/pop，实际是 FIFO           |
| **锁设计**          | 两把独立 Mutex                | **单一 Mutex<ManagerState>** | 避免死锁风险                                |
| **前端背压检测**    | pendingMessages 计数器        | **消息队列 + RAF 批处理**    | 计数器无法测量真正的队列积压                |
| **dirty_rect 安全** | `as u32` 可能溢出             | **先 max(0) 再转 u32**       | 统一安全写法                                |
| **内存限制**        | 64MB                          | **80MB**                     | 支持 4K 画布 (64MB) 留余量                  |
| **性能预估**        | 2.2-3.5x 提升                 | **2x 提升**                  | 更保守估计                                  |

### 5.2 设计决策澄清

#### 关于 "无 clone" 的澄清

v1.2 中提出的 "双缓冲无 clone" 方案**在 Tauri Channel 语义下不可行**：

1. `Channel::send(Vec<u8>)` 消耗 Vec 的所有权
2. 发送后 Vec 被序列化并 drop，无法回收
3. `mem::take` 会将 buffer 置为 capacity=0，下次需重新分配

**v1.3 采用的方案**：

- 使用 **scratch buffer 复用构建过程**，减少填充时的分配
- 发送时仍然 **clone**：`on_sync.send(output_buffer.clone())`
- 真正的优化点在于：**减少构建过程的分配**，而非 IPC 发送

**如需真正的零拷贝（Phase 3+）**：

- 探索 Tauri 的 SharedArrayBuffer 支持
- 或使用内存映射文件 (mmap)

#### 关于 FIFO vs LRU 的澄清

当前设计实际是 **FIFO**（先进先出），不是 LRU：

```rust
// start 时
session_order.push_back(session_id);

// 淘汰时
session_order.pop_front(); // 淘汰最先创建的，不是最久未使用的
```

对于我们的场景，**FIFO 足够**：

- 每个笔画都是独立会话，使用后立即结束
- 不存在"多个会话长期共存，需要淘汰最久未使用"的场景

如需严格 LRU，需要：

- 在 `rust_brush_input` 时 touch 该 session
- 使用 `lru` crate 或手动实现 LinkedHashMap

## 6. 核心实现（v1.3 修正版）

### 6.1 Rust 端：统一锁 + Scratch Buffer

```rust
// src-tauri/src/brush/streaming.rs

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Instant;

use super::{soft_dab::{render_soft_dab, GaussParams}, stroke_buffer::Rect};

/// 内存限制常量
const MAX_BUFFER_SIZE: usize = 80 * 1024 * 1024; // 80MB (支持 4K + 余量)

/// 引擎管理器状态 (Tauri State 托管)
/// 使用单一 Mutex 避免死锁
pub struct BrushEngineManager {
    pub state: Mutex<ManagerState>,
}

/// 管理器内部状态（单一锁保护）
pub struct ManagerState {
    engines: HashMap<String, StreamingBrushEngine>,
    /// 会话创建顺序，用于 FIFO 淘汰
    session_order: VecDeque<String>,
    /// 全局 Session ID 计数器
    session_counter: u64,
}

impl BrushEngineManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(ManagerState {
                engines: HashMap::new(),
                session_order: VecDeque::new(),
                session_counter: 0,
            }),
        }
    }
}

impl ManagerState {
    /// 生成唯一 Session ID
    pub fn next_session_id(&mut self) -> String {
        self.session_counter += 1;
        format!("session_{}", self.session_counter)
    }

    /// FIFO 淘汰最旧会话
    pub fn evict_oldest(&mut self) -> Option<String> {
        if let Some(oldest_id) = self.session_order.pop_front() {
            self.engines.remove(&oldest_id);
            Some(oldest_id)
        } else {
            None
        }
    }
}

/// 流式笔刷引擎状态
pub struct StreamingBrushEngine {
    /// 像素缓冲区 (RGBA, Stroke Layer)
    buffer: Vec<u8>,
    width: u32,
    height: u32,
    /// 累积脏区域
    dirty_rect: Rect,
    /// 同步计数器
    dab_counter: u32,
    /// 上次同步时间
    last_sync: Instant,
    /// 同步阈值
    sync_config: SyncConfig,
    /// Gaussian 参数缓存
    cached_params: Option<GaussParams>,
    cached_params_key: (u32, u32, u32),
    /// Scratch buffer（复用构建过程，发送时仍需 clone）
    output_buffer: Vec<u8>,
}

/// 同步配置 (多阈值)
pub struct SyncConfig {
    pub max_dabs: u32,       // 默认 4
    pub max_ms: u32,         // 默认 16ms (约 60fps)
    pub max_bytes: usize,    // 默认 256KB
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            max_dabs: 4,
            max_ms: 16,
            max_bytes: 256 * 1024,
        }
    }
}

impl StreamingBrushEngine {
    pub fn new(width: u32, height: u32) -> Result<Self, String> {
        let buffer_size = (width * height * 4) as usize;

        // 内存保护检查
        if buffer_size > MAX_BUFFER_SIZE {
            return Err(format!(
                "Canvas too large: {}x{} requires {}MB, max is {}MB. Use Tile mode.",
                width, height,
                buffer_size / (1024 * 1024),
                MAX_BUFFER_SIZE / (1024 * 1024)
            ));
        }

        Ok(Self {
            buffer: vec![0u8; buffer_size],
            width,
            height,
            dirty_rect: Rect::empty(),
            dab_counter: 0,
            last_sync: Instant::now(),
            sync_config: SyncConfig::default(),
            cached_params: None,
            cached_params_key: (0, 0, 0),
            // Scratch buffer：预分配合理大小
            output_buffer: Vec::with_capacity(512 * 1024),
        })
    }

    /// 开始新笔画 (清空 Stroke Layer)
    pub fn begin_stroke(&mut self) {
        self.buffer.fill(0);
        self.dirty_rect = Rect::empty();
        self.dab_counter = 0;
        self.last_sync = Instant::now();
    }

    /// 打一个 dab，返回是否需要同步
    pub fn stamp_dab(
        &mut self,
        cx: f32, cy: f32,
        radius: f32,
        hardness: f32,
        roundness: f32,
        color: (u8, u8, u8),
        flow: f32,
        dab_opacity: f32,
    ) -> bool {
        // 参数缓存检查 (整数像素精度)
        let key = (
            radius.round() as u32,
            (hardness * 100.0) as u32,
            (roundness * 100.0) as u32,
        );

        let params = if self.cached_params_key == key && self.cached_params.is_some() {
            self.cached_params.as_ref().unwrap()
        } else {
            self.cached_params = Some(GaussParams::new(hardness, radius, roundness));
            self.cached_params_key = key;
            self.cached_params.as_ref().unwrap()
        };

        // 调用现有的 SIMD 渲染函数
        let (left, top, w, h) = render_soft_dab(
            &mut self.buffer,
            self.width as usize,
            self.height as usize,
            cx, cy, radius,
            params,
            color,
            flow,
            dab_opacity,
        );

        // 扩展脏区域 (直接 union)
        if w > 0 && h > 0 {
            let dab_rect = Rect::new(
                left as i32,
                top as i32,
                (left + w) as i32,
                (top + h) as i32,
            );
            self.dirty_rect.union(&dab_rect);
        }

        self.dab_counter += 1;

        // 多阈值同步检查
        let elapsed_ms = self.last_sync.elapsed().as_millis() as u32;
        let dirty_bytes = self.dirty_rect_bytes_safe();

        self.dab_counter >= self.sync_config.max_dabs
            || elapsed_ms >= self.sync_config.max_ms
            || dirty_bytes >= self.sync_config.max_bytes
    }

    /// 安全计算脏区域字节数（统一用 max(0) 再转 u32）
    fn dirty_rect_bytes_safe(&self) -> usize {
        if self.dirty_rect.is_empty() {
            return 0;
        }

        // 安全转换：先 max(0) 再转 u32
        let left = self.dirty_rect.left.max(0) as u32;
        let top = self.dirty_rect.top.max(0) as u32;
        let right = (self.dirty_rect.right.max(0) as u32).min(self.width);
        let bottom = (self.dirty_rect.bottom.max(0) as u32).min(self.height);

        if right <= left || bottom <= top {
            return 0;
        }

        ((right - left) * (bottom - top) * 4) as usize
    }

    /// 获取脏区域数据
    /// 使用 scratch buffer 复用构建过程，但发送时仍需 clone
    pub fn get_sync_data(&mut self) -> Option<Vec<u8>> {
        if self.dirty_rect.is_empty() {
            return None;
        }

        // 安全 clamp
        let left = self.dirty_rect.left.max(0) as u32;
        let top = self.dirty_rect.top.max(0) as u32;
        let right = (self.dirty_rect.right.max(0) as u32).min(self.width);
        let bottom = (self.dirty_rect.bottom.max(0) as u32).min(self.height);

        let w = right.saturating_sub(left);
        let h = bottom.saturating_sub(top);

        if w == 0 || h == 0 {
            return None;
        }

        // 复用 scratch buffer（减少构建过程的分配）
        self.output_buffer.clear();

        let header_size = 16;
        let data_size = (w * h * 4) as usize;
        let total_size = header_size + data_size;

        // 只在容量不足时扩容
        if self.output_buffer.capacity() < total_size {
            self.output_buffer.reserve(total_size - self.output_buffer.capacity());
        }

        // Header
        self.output_buffer.extend_from_slice(&left.to_le_bytes());
        self.output_buffer.extend_from_slice(&top.to_le_bytes());
        self.output_buffer.extend_from_slice(&w.to_le_bytes());
        self.output_buffer.extend_from_slice(&h.to_le_bytes());

        // Pixels
        for y in top..bottom {
            let start = (y * self.width + left) as usize * 4;
            let end = start + (w as usize * 4);
            self.output_buffer.extend_from_slice(&self.buffer[start..end]);
        }

        // Reset
        self.dirty_rect = Rect::empty();
        self.dab_counter = 0;
        self.last_sync = Instant::now();

        // Clone 发送（Tauri Channel 需要所有权）
        // Scratch buffer 保留 capacity，下次复用
        Some(self.output_buffer.clone())
    }

    /// end_stroke 时释放过大的 buffer
    pub fn shrink_buffers_if_needed(&mut self) {
        const MAX_RETAINED_SIZE: usize = 10 * 1024 * 1024; // 10MB

        if self.output_buffer.capacity() > MAX_RETAINED_SIZE {
            self.output_buffer = Vec::with_capacity(512 * 1024);
        }
    }
}
```

### 6.2 Rust 端：Tauri Command（统一锁版本）

```rust
// src-tauri/src/commands.rs

use tauri::{State, ipc::Channel};
use crate::brush::streaming::{BrushEngineManager, StreamingBrushEngine};

/// 开始 Rust CPU 笔刷会话
#[tauri::command]
pub fn rust_brush_start(
    state: State<BrushEngineManager>,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let mut manager = state.state.lock().map_err(|e| e.to_string())?;

    // 限制最大会话数，FIFO 淘汰
    if manager.engines.len() >= 8 {
        if let Some(oldest_id) = manager.evict_oldest() {
            tracing::info!("[RustBrush] Evicted oldest session: {}", oldest_id);
        }
    }

    // 生成唯一 Session ID
    let session_id = manager.next_session_id();

    // 创建引擎（带内存保护）
    let mut engine = StreamingBrushEngine::new(width, height)?;
    engine.begin_stroke();

    // 记录会话
    manager.session_order.push_back(session_id.clone());
    manager.engines.insert(session_id.clone(), engine);

    tracing::info!("[RustBrush] Started session: {} ({}x{})", session_id, width, height);
    Ok(session_id)
}

/// 流式笔刷输入点
#[tauri::command]
pub async fn rust_brush_input(
    state: State<'_, BrushEngineManager>,
    on_sync: Channel<Vec<u8>>,
    session_id: String,
    points: Vec<BrushInputPoint>,
    color: (u8, u8, u8),
    size: f32,
    hardness: f32,
    roundness: f32,
    flow: f32,
    opacity: f32,
) -> Result<(), String> {
    // 批量处理，只锁一次
    let sync_data_list: Vec<Vec<u8>> = {
        let mut manager = state.state.lock().map_err(|e| e.to_string())?;
        let engine = manager.engines.get_mut(&session_id)
            .ok_or_else(|| format!("Session not found: {}", session_id))?;

        let mut pending = Vec::new();

        for point in points {
            let needs_sync = engine.stamp_dab(
                point.x, point.y,
                size * point.pressure,
                hardness,
                roundness,
                color,
                flow,
                opacity,
            );

            if needs_sync {
                if let Some(data) = engine.get_sync_data() {
                    pending.push(data);
                }
            }
        }
        pending
    }; // 锁释放

    // 发送在锁外，带错误处理
    for data in sync_data_list {
        if let Err(e) = on_sync.send(data) {
            tracing::error!("[RustBrush] Failed to send sync data: {:?}", e);
        }
    }

    Ok(())
}

/// 结束笔刷会话
#[tauri::command]
pub fn rust_brush_end(
    state: State<BrushEngineManager>,
    on_sync: Channel<Vec<u8>>,
    session_id: String,
) -> Result<(), String> {
    let mut manager = state.state.lock().map_err(|e| e.to_string())?;

    if let Some(engine) = manager.engines.get_mut(&session_id) {
        // 发送剩余脏区域
        if let Some(data) = engine.get_sync_data() {
            if let Err(e) = on_sync.send(data) {
                tracing::error!("[RustBrush] Failed to send final data: {:?}", e);
            }
        }

        // 释放过大的 buffer
        engine.shrink_buffers_if_needed();
    }

    tracing::info!("[RustBrush] Ended session: {}", session_id);
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct BrushInputPoint {
    x: f32,
    y: f32,
    pressure: f32,
}
```

### 6.3 前端：消息队列 + RAF 批处理

```typescript
// src/utils/rustBrushReceiver.ts

import { Channel, invoke } from '@tauri-apps/api/core';

interface SyncMessage {
  data: Uint8Array;
  timestamp: number;
}

export class RustBrushReceiver {
  private channel: Channel<Uint8Array> | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private reusableImageData: ImageData | null = null;
  private sessionId: string = '';

  // 消息队列（用于背压检测）
  private messageQueue: SyncMessage[] = [];
  private rafId: number | null = null;
  private isProcessing: boolean = false;

  // 回调函数
  private compositeCallback: ((strokeCanvas: HTMLCanvasElement) => void) | null = null;
  private fallbackHandler: (() => void) | null = null;

  constructor(options?: {
    onComposite?: (strokeCanvas: HTMLCanvasElement) => void;
    onFallback?: () => void;
  }) {
    this.compositeCallback = options?.onComposite || null;
    this.fallbackHandler = options?.onFallback || null;
  }

  async startStroke(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): Promise<boolean> {
    this.ctx = ctx;
    this.messageQueue = [];
    this.isProcessing = false;

    try {
      // 初始化 Rust 端引擎（返回 session_id）
      this.sessionId = await invoke<string>('rust_brush_start', { width, height });

      // 创建 Channel
      this.channel = new Channel<Uint8Array>();
      this.channel.onmessage = (data) => this.enqueueMessage(data);

      // 错误处理
      if ('onerror' in this.channel) {
        (this.channel as any).onerror = (error: Error) => {
          console.error('[RustBrush] Channel error:', error);
          this.fallbackToTypescript();
        };
      }

      // 启动 RAF 处理循环
      this.startProcessing();

      return true;
    } catch (error) {
      console.error('[RustBrush] Failed to start:', error);
      this.fallbackToTypescript();
      return false;
    }
  }

  /** 消息入队 + 背压检测 */
  private enqueueMessage(data: Uint8Array): void {
    this.messageQueue.push({
      data,
      timestamp: performance.now(),
    });

    // 背压检测：队列过长时警告
    if (this.messageQueue.length > 10) {
      console.warn(
        `[RustBrush] Message queue backlog: ${this.messageQueue.length}`,
        'Consider throttling input'
      );
    }
  }

  /** 启动 RAF 处理循环 */
  private startProcessing(): void {
    if (this.rafId !== null) return;

    const processFrame = () => {
      this.processQueue();
      this.rafId = requestAnimationFrame(processFrame);
    };

    this.rafId = requestAnimationFrame(processFrame);
  }

  /** 停止 RAF 处理循环 */
  private stopProcessing(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** 处理消息队列（每帧批量处理） */
  private processQueue(): void {
    if (!this.ctx || this.messageQueue.length === 0) return;

    this.isProcessing = true;

    // 每帧最多处理 4 条消息，避免阻塞
    const maxPerFrame = 4;
    const toProcess = this.messageQueue.splice(0, maxPerFrame);

    for (const msg of toProcess) {
      this.handleSync(msg.data);
    }

    this.isProcessing = false;
  }

  /** 处理单条同步消息 */
  private handleSync(data: Uint8Array): void {
    if (!this.ctx) return;

    // 解析 header (16 bytes)
    const view = new DataView(data.buffer, data.byteOffset);
    const left = view.getUint32(0, true);
    const top = view.getUint32(4, true);
    const width = view.getUint32(8, true);
    const height = view.getUint32(12, true);

    // 复用 ImageData
    if (
      !this.reusableImageData ||
      this.reusableImageData.width !== width ||
      this.reusableImageData.height !== height
    ) {
      this.reusableImageData = new ImageData(width, height);
    }

    // 拷贝像素数据
    const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset + 16, width * height * 4);
    this.reusableImageData.data.set(pixels);

    // 绘制
    this.ctx.putImageData(this.reusableImageData, left, top);
  }

  async processPoints(
    points: Array<{ x: number; y: number; pressure: number }>,
    brushParams: {
      color: [number, number, number];
      size: number;
      hardness: number;
      roundness: number;
      flow: number;
      opacity: number;
    }
  ): Promise<void> {
    if (!this.channel || !this.sessionId) return;

    try {
      await invoke('rust_brush_input', {
        onSync: this.channel,
        sessionId: this.sessionId,
        points,
        ...brushParams,
      });
    } catch (error) {
      console.error('[RustBrush] Input failed:', error);
      this.fallbackToTypescript();
    }
  }

  async endStroke(): Promise<void> {
    if (!this.channel || !this.sessionId) return;

    try {
      // 发送最后的数据
      await invoke('rust_brush_end', {
        onSync: this.channel,
        sessionId: this.sessionId,
      });

      // 等待队列清空
      await this.waitForQueueEmpty();

      // 处理剩余消息
      while (this.messageQueue.length > 0) {
        this.processQueue();
      }

      // 触发合成回调
      if (this.compositeCallback && this.ctx?.canvas) {
        this.compositeCallback(this.ctx.canvas);
      }
    } catch (error) {
      console.error('[RustBrush] End failed:', error);
    } finally {
      this.cleanup();
    }
  }

  /** 等待队列清空（事件驱动，非轮询） */
  private async waitForQueueEmpty(timeoutMs: number = 100): Promise<void> {
    const start = Date.now();
    while (this.messageQueue.length > 0 && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  private fallbackToTypescript(): void {
    console.error('[RustBrush] Fatal error, falling back to TypeScript');
    this.cleanup();

    if (this.fallbackHandler) {
      this.fallbackHandler();
    }
  }

  private cleanup(): void {
    this.stopProcessing();
    this.channel = null;
    this.ctx = null;
    this.sessionId = '';
    this.messageQueue = [];
  }

  /** 检查是否正在活跃绘画 */
  get isActive(): boolean {
    return this.channel !== null && this.sessionId !== '';
  }

  /** 获取当前队列长度（用于调试） */
  get queueLength(): number {
    return this.messageQueue.length;
  }
}
```

## 7. 性能预估（v1.3 保守版）

### 7.1 计算对比

| 操作                | TypeScript | Rust SIMD | 提升倍数 |
| ------------------- | ---------- | --------- | -------- |
| Mask 生成 (100px)   | ~2ms       | ~0.1ms    | **20x**  |
| Alpha Blend (100px) | ~3ms       | ~0.2ms    | **15x**  |
| **Dab 总计**        | ~5ms       | ~0.3ms    | **17x**  |

### 7.2 端到端延迟预估（v1.3 保守版）

| 阶段             | TypeScript | Rust v1.3 | 说明         |
| ---------------- | ---------- | --------- | ------------ |
| 计算 (500px dab) | 10ms       | 2.0ms     | SIMD 优势    |
| 构建 + Clone     | -          | 0.8ms     | 含 memcpy    |
| Channel 传输     | -          | 0.5ms     | 已验证       |
| putImageData     | -          | 1.5ms     | 浏览器差异大 |
| **总计**         | 10ms       | **4.8ms** |              |
| **提升倍数**     | -          | **2.1x**  | 保守估计     |

### 7.3 内存占用预估

| 画布尺寸   | Stroke Buffer | 输出 Buffer | 总计 | 是否达标     |
| ---------- | ------------- | ----------- | ---- | ------------ |
| 2K (2048²) | 16MB          | 1MB         | 17MB | ✅ 可接受    |
| 4K (4096²) | 64MB          | 4MB         | 68MB | ✅ 80MB 内   |
| 8K (8192²) | -             | -           | -    | ❌ 必须 Tile |

## 8. 实施路线图（v1.3 版）

### Phase 0.1: 架构修正 (1 天)

- [ ] 创建 `brush/streaming.rs` 基础结构
- [ ] 实现 `Rect::union()` 和单元测试
- [ ] 统一锁 `ManagerState` 设计
- [ ] 多阈值同步策略

### Phase 0.2: 核心实现 (1 天)

- [ ] Scratch buffer + clone 模式
- [ ] 批量处理 + 锁外 send
- [ ] 内存限制检查 (80MB)
- [ ] `dirty_rect_bytes_safe()` 安全计算

### Phase 0.3: 前端集成 (0.5 天)

- [ ] 消息队列 + RAF 批处理
- [ ] 背压检测 + 告警
- [ ] 降级逻辑完善
- [ ] FIFO 会话管理

### Phase 0.5: 测试基础设施 (1 天)

- [ ] Rust 单元测试
  - `render_soft_dab` 输出验证
  - `Rect::union()` 边界测试
  - clone 耗时基准
- [ ] 性能基准测试
  - `begin_stroke` 清空耗时
  - `get_sync_data` 构建 + clone 耗时
  - `putImageData` 耗时分布 (P50/P90/P95)

### Phase 1: MVP + 性能验证 (3 天)

- [ ] 完成 Tauri commands 接入
- [ ] 前端 `RustBrushReceiver` 集成
- [ ] **关键里程碑**：实测性能
  - 目标：500px dab P90 < 5ms
  - 分解：Rust < 2.5ms, Clone < 1ms, putImageData < 1.5ms
  - 如果总延迟 > 6ms，需要分析瓶颈

### Phase 2: 功能拉齐 (3-4 天)

- [ ] **Mask Cache** (整数像素精度)
- [ ] **Hard Brush 快速路径**
- [ ] **Alpha Darken 混合** 调整
- [ ] 与 TS 渲染结果一致性验证

### Phase 3: 高级特性 (按需)

- [ ] **Wet Edge** (LUT-based)
- [ ] **Texture Brush**
- [ ] **Tile 机制** (8K+ 支持)
- [ ] 探索 SharedArrayBuffer (真正零拷贝)

## 9. 风险与缓解

| 风险              | 影响       | 缓解策略                             |
| ----------------- | ---------- | ------------------------------------ |
| Clone 开销过高    | 性能不达标 | Phase 0.5 基准测试，确认是否真是瓶颈 |
| putImageData 抖动 | 预览卡顿   | RAF 批处理 + createImageBitmap 备选  |
| 内存占用过高      | OOM        | 80MB 上限 + Phase 3 Tile 机制        |
| 渲染结果不一致    | 视觉差异   | Phase 2 验证 + sRGB + Straight Alpha |
| 性能提升 < 1.8x   | 不值得     | Phase 1 决策点：暂停或继续           |

## 10. 决策点

### Phase 1 结束时

- **继续条件**：500px dab P90 < 5ms，提升 ≥ 2x
- **暂停条件**：P90 > 6ms，或提升 < 1.8x
- **备选**：保留 TypeScript 实现作为 fallback

### 如果 Clone 是瓶颈

优先级排序：

1. 优化构建过程（减少 extend_from_slice 次数）
2. 尝试 `createImageBitmap` 替代 putImageData
3. Phase 3 探索 SharedArrayBuffer

## 11. 技术细节说明

### 11.1 颜色空间

- Rust 端使用 **sRGB** 颜色空间，与 Canvas2D 一致
- Alpha 混合使用 **Straight Alpha**（非预乘）
- 输出数据格式：RGBA8 (每通道 0-255)

### 11.2 抗锯齿

- `render_soft_dab` 已通过 Gaussian 函数实现亚像素精度
- 边缘自然过渡，无需额外 AA 处理
- Hard Brush 使用 1px AA 边缘

### 11.3 与其他模块集成

- **Cursor Preview**: 前端独立实现，不依赖 Rust
- **Undo/Redo**: `endStroke()` 后，前端将合成结果推入历史栈
- **Layer System**: Stroke Layer 是临时的，不参与图层管理

### 11.4 性能测试方法

- **Cold Start**: 第一次 500px dab（无 Mask 缓存）
- **Warm**: 后续 dabs（有 Mask 缓存）
- **指标**: P50, P90, P95 延迟
- **工具**: `performance.now()` 前后端埋点

## 12. 与其他文档关系

- **废弃**: `rust-brush-engine-revival.md` (该方案面向 GPU，本方案面向 CPU)
- **参考**: `soft-brush-performance-optimization.md` (优化经验)
- **参考**: `review.md` (外部评审反馈 v1.0-v1.3)
- **更新**: `architecture.md` (添加 Rust CPU 引擎描述)

## 附录 A: 历史决策记录

### IPC 问题回顾

早期 Rust CPU 方案被废弃的原因：

1. 使用 JSON 序列化传输整个 buffer
2. 每次调用都有 IPC 往返开销
3. 主线程阻塞等待结果

当前方案解决：

1. 使用二进制 Channel (零序列化)
2. 只传输脏区域
3. 异步非阻塞
4. 批量处理减少锁竞争

## 附录 B: Review 反馈整合记录

### v1.0 → v1.1 修正

- 全局单例 → HashMap 多实例管理
- dirty_rect 计算修正
- 锁粒度优化
- Buffer Pool 复用
- 多阈值同步策略
- buffer 语义明确化 (Stroke Layer)

### v1.1 → v1.2 修正

- 尝试双缓冲无 clone
- 随机淘汰 → VecDeque FIFO
- Session ID 递增计数器
- dirty_rect_bytes 安全计算
- 内存保护 64MB 上限
- 前端降级逻辑完善

### v1.2 → v1.3 修正（关键）

- **双缓冲无 clone 不可行** → 改回 scratch buffer + clone
- **LRU 误称** → 明确是 FIFO
- **两把锁** → 合并为单一 `ManagerState` 锁
- **pendingMessages 计数** → 消息队列 + RAF 批处理
- **dirty_rect 溢出** → 统一先 max(0) 再 as u32
- **内存限制** → 64MB → 80MB (支持 4K)
- **性能预估** → 从 3x 降为 2x

## 附录 C: 为什么不能真正 "无 Clone"

### Tauri Channel 的所有权语义

```rust
// Tauri Channel::send 签名
fn send(&self, data: T) -> Result<(), Error>
```

`send` 消耗 `data` 的所有权，发送后 Vec 被：

1. 序列化为二进制
2. 通过 IPC 发送给 WebView
3. **Drop**（内存释放）

### 为什么双缓冲不起作用

```rust
// v1.2 的错误设计
let output = &mut self.output_buffers[buffer_idx];
Some(std::mem::take(output))  // output 变成 Vec::new()，capacity 丢失

// 或者
Some(std::mem::swap(...))  // 新 Vec 被 send 后 drop，也无法回收
```

无论用 `take` 还是 `swap`，Vec 发送后都会被 drop，无法"归还"给 Rust 端。

### 真正的解决方案（Phase 3）

如需真正的零拷贝，需要：

1. **SharedArrayBuffer**: JS 和 Rust 共享同一块内存
2. **Memory-mapped file**: 通过文件系统共享
3. **WebAssembly Memory**: 直接操作 WASM 线性内存

这些都需要额外的复杂度，不适合 MVP 阶段。

### v1.3 的折中方案

```rust
// 复用 scratch buffer 构建过程
self.output_buffer.clear();
// ... 填充数据（复用 capacity，无需 realloc）

// 发送时仍需 clone
Some(self.output_buffer.clone())
```

优化点：**构建过程不分配**，clone 时一次性分配 + memcpy。

实测中，clone 1MB 数据约 0.3-0.5ms，相比 putImageData 的 1.5ms，**可能不是主要瓶颈**。

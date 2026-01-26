# Rust CPU 笔刷引擎设计方案

> **状态**: 📝 规划中 (v1.5 - 修复关键 P0 问题)
> **前置条件**: Tauri v2 Channel IPC 测试通过 (Avg Jitter < 0.4ms)
> **目标**: 替代 TypeScript CPU 笔刷，提供高性能 CPU 渲染路径
> **目标平台**: Windows (WebView2/Chromium)
> **置信度评估**: 80% (技术可行 90%, 性能目标 70%, 内存目标 80%)

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

## 3. 架构设计

### 3.1 核心思路

**Rust 端维护 Stroke Layer（单笔画临时层）**，执行所有像素级计算（Mask + Blending）。仅在需要时通过 Channel 传输 dirty rect 到前端进行 Canvas 显示。

**关键语义澄清**：

- `buffer` = **Stroke Layer**（单笔画临时层）
- `begin_stroke()` **仅清理上次 stroke 的 accumulated 区域**
- `end_stroke()` **移除 session**（释放内存）

### 3.2 双矩形语义（v1.5 关键修正）

```
┌─────────────────────────────────────────────────────────┐
│ sync_dirty_rect                                          │
│   ├── 自上次 sync 以来的增量脏区域                       │
│   ├── stamp_dab() 时累加                                 │
│   └── get_sync_data() 后清空                             │
│                                                          │
│ accumulated_dirty_rect                                   │
│   ├── 当前 stroke 总脏区域                               │
│   ├── stamp_dab() 时累加                                 │
│   ├── get_sync_data() 后保持不变                         │
│   └── end_stroke() 后赋给 last_stroke_dirty 并清空       │
│                                                          │
│ last_stroke_dirty                                        │
│   └── 上一次 stroke 的总脏区域，begin_stroke() 用于清理  │
└─────────────────────────────────────────────────────────┘
```

### 3.3 数据流

```
┌──────────────────────────────────────────────────────────────────┐
│                        Rust Backend                               │
│                                                                   │
│  ┌─────────────┐    ┌──────────────────┐    ┌─────────────────┐  │
│  │ Input Event │───►│ BrushStamper     │───►│ StreamingEngine │  │
│  │ (x,y,p)     │    │ (existing code)  │    │ (per-session)   │  │
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
│  │ Output: sync_dirty_rect (增量) + clone                       │  │
│  │ 锁策略: 单一 ManagerState Mutex + Arc<Mutex<Engine>>         │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## 4. Review 反馈与修正 (v1.5)

### 4.1 P0 关键修正

| 问题                        | v1.4             | v1.5 修正                       | 理由                    |
| --------------------------- | ---------------- | ------------------------------- | ----------------------- |
| **dirty_rect 未清空**       | sync 后不清      | **双矩形机制**                  | 避免重复发送 + 阈值失效 |
| **锁顺序不一致**            | 分离锁死锁风险   | **统一 ManagerState + Arc**     | 避免死锁                |
| **全局锁持有期间锁 engine** | per-session 阻塞 | **Arc clone 后立即释放 Map 锁** | 真正实现互不阻塞        |

### 4.2 P1 优化

| 问题                     | 修正                    |
| ------------------------ | ----------------------- |
| `createImageBitmap` 乱序 | 串行链 `bitmapChain`    |
| cleanup 可能卡住         | 两阶段清理 + `try_lock` |

### 4.3 平台说明

- **目标平台**: Windows (Edge WebView2)
- **不考虑**: Safari、移动端浏览器
- `putImageData` 在 Chrome/Edge 上表现稳定，无需过度担心

## 5. 核心实现（v1.5 修正版）

### 5.1 Rust 端：统一锁 + Arc + 双矩形

```rust
// src-tauri/src/brush/streaming.rs

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::stroke_buffer::Rect;

/// 内存限制常量
const MAX_BUFFER_SIZE: usize = 80 * 1024 * 1024; // 80MB
const SESSION_TIMEOUT_SECS: u64 = 60;

/// 引擎管理器（统一锁，避免锁顺序问题）
pub struct BrushEngineManager {
    pub state: Mutex<ManagerState>,
}

/// 管理器内部状态（单一锁保护）
pub struct ManagerState {
    /// Session -> Engine (Arc 实现真正的 per-session 锁分离)
    engines: HashMap<String, Arc<Mutex<StreamingBrushEngine>>>,
    /// FIFO 会话顺序
    session_order: VecDeque<String>,
    /// Session ID 计数器
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
    pub fn evict_oldest(&mut self) {
        if let Some(oldest_id) = self.session_order.pop_front() {
            self.engines.remove(&oldest_id);
            tracing::info!("[RustBrush] Evicted oldest session: {}", oldest_id);
        }
    }

    /// 移除指定会话
    pub fn remove_session(&mut self, session_id: &str) {
        self.engines.remove(session_id);
        self.session_order.retain(|id| id != session_id);
        tracing::info!("[RustBrush] Removed session: {}", session_id);
    }

    /// 获取 engine Arc（用于在锁外操作）
    pub fn get_engine(&self, session_id: &str) -> Option<Arc<Mutex<StreamingBrushEngine>>> {
        self.engines.get(session_id).cloned()
    }
}

/// 流式笔刷引擎状态
pub struct StreamingBrushEngine {
    /// 像素缓冲区 (RGBA, Stroke Layer)
    buffer: Vec<u8>,
    width: u32,
    height: u32,

    // === 双矩形语义 (v1.5 关键) ===
    /// 自上次 sync 以来的增量脏区域（sync 后清空）
    sync_dirty_rect: Rect,
    /// 当前 stroke 总脏区域（用于 begin_stroke 清理）
    accumulated_dirty_rect: Rect,
    /// 上一次 stroke 的总脏区域
    last_stroke_dirty: Rect,

    /// 同步计数器
    dab_counter: u32,
    /// 上次同步时间
    last_sync: Instant,
    /// 最后活动时间
    last_activity: Instant,
    /// 同步阈值
    sync_config: SyncConfig,
    /// Gaussian 参数缓存（量化桶策略）
    cached_params: Option<GaussParams>,
    cached_params_key: (u32, u32, u32),
    /// Scratch buffer
    output_buffer: Vec<u8>,
}

/// 同步配置
pub struct SyncConfig {
    pub max_dabs: u32,
    pub max_ms: u32,
    pub max_bytes: usize,
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

        if buffer_size > MAX_BUFFER_SIZE {
            return Err(format!(
                "Canvas too large: {}x{} requires {}MB, max is {}MB.",
                width, height,
                buffer_size / (1024 * 1024),
                MAX_BUFFER_SIZE / (1024 * 1024)
            ));
        }

        let now = Instant::now();
        Ok(Self {
            buffer: vec![0u8; buffer_size],
            width,
            height,
            sync_dirty_rect: Rect::empty(),
            accumulated_dirty_rect: Rect::empty(),
            last_stroke_dirty: Rect::empty(),
            dab_counter: 0,
            last_sync: now,
            last_activity: now,
            sync_config: SyncConfig::default(),
            cached_params: None,
            cached_params_key: (0, 0, 0),
            output_buffer: Vec::with_capacity(512 * 1024),
        })
    }

    /// 开始新笔画（仅清理上次 stroke 的区域）
    pub fn begin_stroke(&mut self) {
        self.last_activity = Instant::now();

        // 仅清理上次 stroke 画过的区域（智能清空）
        if !self.last_stroke_dirty.is_empty() {
            self.clear_rect(&self.last_stroke_dirty.clone());
        }

        // 重置所有脏区域
        self.sync_dirty_rect = Rect::empty();
        self.accumulated_dirty_rect = Rect::empty();
        self.dab_counter = 0;
        self.last_sync = Instant::now();
    }

    /// 清理指定矩形区域
    fn clear_rect(&mut self, rect: &Rect) {
        let left = rect.left.max(0) as u32;
        let top = rect.top.max(0) as u32;
        let right = (rect.right.max(0) as u32).min(self.width);
        let bottom = (rect.bottom.max(0) as u32).min(self.height);

        if right <= left || bottom <= top {
            return;
        }

        let row_bytes = ((right - left) * 4) as usize;
        for y in top..bottom {
            let start = (y * self.width + left) as usize * 4;
            self.buffer[start..start + row_bytes].fill(0);
        }
    }

    /// 结束笔画
    pub fn end_stroke(&mut self) {
        // 保存总脏区域供下次 begin_stroke 清理
        self.last_stroke_dirty = self.accumulated_dirty_rect.clone();
        self.accumulated_dirty_rect = Rect::empty();
        self.sync_dirty_rect = Rect::empty();
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
        self.last_activity = Instant::now();

        // 量化桶策略：2% 容差
        let key = (
            (radius * 50.0).round() as u32,
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

        // 扩展脏区域（双矩形都要累加）
        if w > 0 && h > 0 {
            let dab_rect = Rect::new(
                left as i32,
                top as i32,
                (left + w) as i32,
                (top + h) as i32,
            );
            self.sync_dirty_rect.union(&dab_rect);
            self.accumulated_dirty_rect.union(&dab_rect);
        }

        self.dab_counter += 1;

        // 多阈值同步检查（使用 sync_dirty_rect）
        let elapsed_ms = self.last_sync.elapsed().as_millis() as u32;
        let dirty_bytes = self.sync_dirty_rect_bytes();

        self.dab_counter >= self.sync_config.max_dabs
            || elapsed_ms >= self.sync_config.max_ms
            || dirty_bytes >= self.sync_config.max_bytes
    }

    /// 计算 sync_dirty_rect 字节数
    fn sync_dirty_rect_bytes(&self) -> usize {
        if self.sync_dirty_rect.is_empty() {
            return 0;
        }

        let left = self.sync_dirty_rect.left.max(0) as u32;
        let top = self.sync_dirty_rect.top.max(0) as u32;
        let right = (self.sync_dirty_rect.right.max(0) as u32).min(self.width);
        let bottom = (self.sync_dirty_rect.bottom.max(0) as u32).min(self.height);

        if right <= left || bottom <= top {
            return 0;
        }

        ((right - left) * (bottom - top) * 4) as usize
    }

    /// 获取脏区域数据（使用 sync_dirty_rect，发送后清空）
    pub fn get_sync_data(&mut self) -> Option<Vec<u8>> {
        if self.sync_dirty_rect.is_empty() {
            return None;
        }

        let left = self.sync_dirty_rect.left.max(0) as u32;
        let top = self.sync_dirty_rect.top.max(0) as u32;
        let right = (self.sync_dirty_rect.right.max(0) as u32).min(self.width);
        let bottom = (self.sync_dirty_rect.bottom.max(0) as u32).min(self.height);

        let w = right.saturating_sub(left);
        let h = bottom.saturating_sub(top);

        if w == 0 || h == 0 {
            return None;
        }

        self.output_buffer.clear();

        let header_size = 16;
        let data_size = (w * h * 4) as usize;
        let total_size = header_size + data_size;

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

        // 清空 sync_dirty_rect（accumulated 保持不变）
        self.sync_dirty_rect = Rect::empty();
        self.dab_counter = 0;
        self.last_sync = Instant::now();

        Some(self.output_buffer.clone())
    }
}

// 占位符，实际从现有代码导入
use super::soft_dab::{render_soft_dab, GaussParams};
```

### 5.2 Rust 端：Tauri Command（Arc 分离锁版本）

```rust
// src-tauri/src/commands.rs

use std::sync::Arc;
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

    // 限制最大会话数
    if manager.engines.len() >= 8 {
        manager.evict_oldest();
    }

    // 生成 Session ID
    let session_id = manager.next_session_id();

    // 创建引擎
    let engine = StreamingBrushEngine::new(width, height)?;

    // 插入 Arc<Mutex<Engine>>
    manager.engines.insert(session_id.clone(), Arc::new(Mutex::new(engine)));
    manager.session_order.push_back(session_id.clone());

    tracing::info!("[RustBrush] Started session: {} ({}x{})", session_id, width, height);
    Ok(session_id)
}

/// 开始新笔画
#[tauri::command]
pub fn rust_brush_begin_stroke(
    state: State<BrushEngineManager>,
    session_id: String,
) -> Result<(), String> {
    // 获取 Arc 后立即释放 manager 锁
    let engine_arc = {
        let manager = state.state.lock().map_err(|e| e.to_string())?;
        manager.get_engine(&session_id)
            .ok_or_else(|| format!("Session not found: {}", session_id))?
    }; // manager 锁在这里释放

    // 在 manager 锁外操作 engine
    let mut engine = engine_arc.lock().map_err(|e| e.to_string())?;
    engine.begin_stroke();
    Ok(())
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
    // 获取 Arc 后立即释放 manager 锁（关键：真正实现 per-session 不互锁）
    let engine_arc = {
        let manager = state.state.lock().map_err(|e| e.to_string())?;
        manager.get_engine(&session_id)
            .ok_or_else(|| format!("Session not found: {}", session_id))?
    }; // manager 锁在这里释放

    // 在 manager 锁外进行耗时计算
    let sync_data_list: Vec<Vec<u8>> = {
        let mut engine = engine_arc.lock().map_err(|e| e.to_string())?;

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
    };

    // 发送在锁外
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
    // 先获取 Arc 并发送最后的数据
    let engine_arc = {
        let manager = state.state.lock().map_err(|e| e.to_string())?;
        manager.get_engine(&session_id)
    };

    if let Some(arc) = engine_arc {
        let mut engine = arc.lock().map_err(|e| e.to_string())?;

        // 发送剩余脏区域
        if let Some(data) = engine.get_sync_data() {
            if let Err(e) = on_sync.send(data) {
                tracing::error!("[RustBrush] Failed to send final data: {:?}", e);
            }
        }

        engine.end_stroke();
    }

    // 移除会话
    {
        let mut manager = state.state.lock().map_err(|e| e.to_string())?;
        manager.remove_session(&session_id);
    }

    Ok(())
}

/// 清理超时会话（两阶段清理，避免长时间持锁）
#[tauri::command]
pub fn rust_brush_cleanup(state: State<BrushEngineManager>) -> Result<u32, String> {
    let now = std::time::Instant::now();

    // 阶段 1：收集所有 Arc，快速释放 manager 锁
    let engine_arcs: Vec<(String, Arc<Mutex<StreamingBrushEngine>>)> = {
        let manager = state.state.lock().map_err(|e| e.to_string())?;
        manager.engines.iter()
            .map(|(id, arc)| (id.clone(), arc.clone()))
            .collect()
    };

    // 阶段 2：检查超时（使用 try_lock 避免阻塞）
    let mut stale_ids = Vec::new();
    for (id, arc) in engine_arcs {
        if let Ok(engine) = arc.try_lock() {
            if now.duration_since(engine.last_activity).as_secs() > 60 {
                stale_ids.push(id);
            }
        }
        // 如果 try_lock 失败，说明正在使用，跳过
    }

    // 阶段 3：移除超时会话
    let count = stale_ids.len() as u32;
    if !stale_ids.is_empty() {
        let mut manager = state.state.lock().map_err(|e| e.to_string())?;
        for id in stale_ids {
            manager.remove_session(&id);
            tracing::warn!("[RustBrush] Cleaned up stale session: {}", id);
        }
    }

    Ok(count)
}

#[derive(serde::Deserialize)]
pub struct BrushInputPoint {
    x: f32,
    y: f32,
    pressure: f32,
}
```

### 5.3 前端：串行化 Bitmap 渲染

```typescript
// src/utils/rustBrushReceiver.ts

import { Channel, invoke } from '@tauri-apps/api/core';

type RenderStrategy = 'putImageData' | 'createImageBitmap';

interface SyncMessage {
  data: Uint8Array;
  timestamp: number;
}

export class RustBrushReceiver {
  private channel: Channel<Uint8Array> | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private reusableImageData: ImageData | null = null;
  private sessionId: string = '';

  // 消息队列
  private messageQueue: SyncMessage[] = [];
  private rafId: number | null = null;

  // 配置
  private renderStrategy: RenderStrategy = 'putImageData';
  private maxQueueLength: number = 8;

  // Bitmap 串行链（避免乱序）
  private bitmapChain: Promise<void> = Promise.resolve();

  // 回调
  private compositeCallback: ((strokeCanvas: HTMLCanvasElement) => void) | null = null;
  private fallbackHandler: (() => void) | null = null;

  constructor(options?: {
    onComposite?: (strokeCanvas: HTMLCanvasElement) => void;
    onFallback?: () => void;
    renderStrategy?: RenderStrategy;
    maxQueueLength?: number;
  }) {
    this.compositeCallback = options?.onComposite || null;
    this.fallbackHandler = options?.onFallback || null;
    this.renderStrategy = options?.renderStrategy || 'putImageData';
    this.maxQueueLength = options?.maxQueueLength || 8;
  }

  async startStroke(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): Promise<boolean> {
    this.ctx = ctx;
    this.messageQueue = [];
    this.bitmapChain = Promise.resolve();

    try {
      this.sessionId = await invoke<string>('rust_brush_start', { width, height });
      await invoke('rust_brush_begin_stroke', { sessionId: this.sessionId });

      this.channel = new Channel<Uint8Array>();
      this.channel.onmessage = (data) => this.enqueueMessage(data);

      this.startProcessing();
      return true;
    } catch (error) {
      console.error('[RustBrush] Failed to start:', error);
      this.fallbackToTypescript();
      return false;
    }
  }

  /** 消息入队 + 丢帧 */
  private enqueueMessage(data: Uint8Array): void {
    const msg: SyncMessage = { data, timestamp: performance.now() };

    if (this.messageQueue.length >= this.maxQueueLength) {
      const first = this.messageQueue[0];
      this.messageQueue = [first, msg];
      console.warn('[RustBrush] Queue overflow, dropped intermediate frames');
    } else {
      this.messageQueue.push(msg);
    }
  }

  private startProcessing(): void {
    if (this.rafId !== null) return;

    const processFrame = () => {
      this.processQueue();
      this.rafId = requestAnimationFrame(processFrame);
    };

    this.rafId = requestAnimationFrame(processFrame);
  }

  private stopProcessing(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** 处理消息队列 */
  private processQueue(): void {
    if (!this.ctx || this.messageQueue.length === 0) return;

    const maxPerFrame = 4;
    const toProcess = this.messageQueue.splice(0, maxPerFrame);

    for (const msg of toProcess) {
      this.handleSync(msg.data);
    }
  }

  /** 处理单条同步消息 */
  private handleSync(data: Uint8Array): void {
    if (!this.ctx) return;

    const view = new DataView(data.buffer, data.byteOffset);
    const left = view.getUint32(0, true);
    const top = view.getUint32(4, true);
    const width = view.getUint32(8, true);
    const height = view.getUint32(12, true);

    if (this.renderStrategy === 'createImageBitmap') {
      // 串行化：链式调用，保证顺序
      this.bitmapChain = this.bitmapChain
        .then(() => this.renderWithBitmap(data, left, top, width, height))
        .catch((err) => {
          console.error('[RustBrush] Bitmap render error:', err);
          // 降级到 putImageData
          this.renderStrategy = 'putImageData';
          this.renderWithPutImageData(data, left, top, width, height);
        });
    } else {
      this.renderWithPutImageData(data, left, top, width, height);
    }
  }

  /** 方案 A: putImageData (默认，同步) */
  private renderWithPutImageData(
    data: Uint8Array,
    left: number,
    top: number,
    width: number,
    height: number
  ): void {
    if (!this.ctx) return;

    if (
      !this.reusableImageData ||
      this.reusableImageData.width !== width ||
      this.reusableImageData.height !== height
    ) {
      this.reusableImageData = new ImageData(width, height);
    }

    const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset + 16, width * height * 4);
    this.reusableImageData.data.set(pixels);
    this.ctx.putImageData(this.reusableImageData, left, top);
  }

  /** 方案 B: createImageBitmap (备选，异步但串行化) */
  private async renderWithBitmap(
    data: Uint8Array,
    left: number,
    top: number,
    width: number,
    height: number
  ): Promise<void> {
    if (!this.ctx) return;

    const imageData = new ImageData(
      new Uint8ClampedArray(data.buffer, data.byteOffset + 16, width * height * 4),
      width,
      height
    );

    // Windows Edge WebView2 支持这些选项
    const bitmap = await createImageBitmap(imageData, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });

    this.ctx.drawImage(bitmap, left, top);
    bitmap.close();
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
      await invoke('rust_brush_end', {
        onSync: this.channel,
        sessionId: this.sessionId,
      });

      // 等待 bitmap 链完成
      await this.bitmapChain;

      // 处理剩余队列
      while (this.messageQueue.length > 0) {
        this.processQueue();
        await new Promise((r) => requestAnimationFrame(r));
      }

      if (this.compositeCallback && this.ctx?.canvas) {
        this.compositeCallback(this.ctx.canvas);
      }
    } catch (error) {
      console.error('[RustBrush] End failed:', error);
    } finally {
      this.cleanup();
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
    this.bitmapChain = Promise.resolve();
  }

  get isActive(): boolean {
    return this.channel !== null && this.sessionId !== '';
  }

  get queueLength(): number {
    return this.messageQueue.length;
  }

  setRenderStrategy(strategy: RenderStrategy): void {
    this.renderStrategy = strategy;
  }
}
```

## 6. 性能预估（v1.5 版）

### 6.1 端到端延迟预估（Windows + Edge WebView2）

| 阶段                  | 预估值    | 说明                  |
| --------------------- | --------- | --------------------- |
| Rust 计算 (500px dab) | 1.5-2.5ms | SIMD 优化             |
| 构建 + Clone          | 0.5-0.8ms | scratch buffer 复用   |
| Channel 传输          | 0.4-0.6ms | 已验证                |
| putImageData          | 1.0-2.0ms | Edge 表现稳定         |
| **总计**              | 3.4-5.9ms | **目标 < 5ms 可达成** |

### 6.2 置信度评估

| 维度     | v1.4 | v1.5    | 说明              |
| -------- | ---- | ------- | ----------------- |
| 技术可行 | 85%  | **90%** | 修复死锁/双矩形   |
| 性能目标 | 60%  | **70%** | 锁分离 + 增量同步 |
| 内存目标 | 75%  | **80%** | 智能清空更完善    |
| **总体** | 72%  | **80%** |                   |

## 7. 实施路线图（v1.5 版）

### Phase 0.1: 架构基础 (1 天)

- [ ] 创建 `Rect` 结构体 + `union()/is_empty()`
- [ ] 实现 `ManagerState` + `Arc<Mutex<Engine>>`
- [ ] 双矩形语义 (`sync_dirty_rect` + `accumulated_dirty_rect`)

### Phase 0.2: 核心实现 (1 天)

- [ ] 智能清空 (`clear_rect`)
- [ ] 量化桶 mask cache
- [ ] 多阈值同步

### Phase 0.3: 前端集成 (0.5 天)

- [ ] 消息队列 + RAF
- [ ] 丢帧机制
- [ ] Bitmap 串行链

### Phase 0.5: 测试 (1 天)

- [ ] Rust 单元测试
  - `Rect::union()` 边界
  - 双矩形语义验证
  - 锁不死锁压力测试
- [ ] 性能基准
  - clone 耗时
  - putImageData P50/P90

### Phase 1: MVP (3 天)

- [ ] Tauri commands 完整接入
- [ ] 端到端集成
- [ ] 性能验证

## 8. 验收规则

### 8.1 锁/并发验收

- 统一锁顺序（无死锁风险）
- 多 session 并发 start/input/end 不阻塞

### 8.2 dirty_rect 语义验收

- stamp → sync → stamp → sync 不重复发送
- begin_stroke 后 stroke layer 全透明

### 8.3 前端渲染验收

- bitmap 策略保证顺序（最后一帧最后绘制）
- 丢帧保留首尾帧

## 附录 A: v1.4 → v1.5 关键修正

| 问题                    | 修正                                              |
| ----------------------- | ------------------------------------------------- |
| `dirty_rect` 未清空     | 引入 `sync_dirty_rect` + `accumulated_dirty_rect` |
| 锁顺序不一致            | 统一 `Mutex<ManagerState>`                        |
| 全局锁持有期间锁 engine | `Arc<Mutex<Engine>>` + 查完立即释放               |
| bitmap 乱序             | 串行链 `bitmapChain`                              |
| cleanup 阻塞            | 两阶段清理 + `try_lock`                           |

## 附录 B: 待确认事项

1. **`render_soft_dab` 返回值**: 确认返回 `(left, top, w, h)`
2. **`GaussParams::new`**: 确认参数顺序
3. **SIMD 对齐**: 确认使用 unaligned 指令

# Rust CPU 笔刷引擎设计方案

> **状态**: 📝 规划中 (v1.7 - 修正 Channel 生命周期与并发模型)
> **前置条件**: Tauri v2 Channel IPC 测试通过 (Avg Jitter < 0.4ms)
> **目标**: 替代 TypeScript CPU 笔刷，提供高性能 CPU 渲染路径
> **目标平台**: Windows (WebView2/Chromium)
> **置信度评估**: 90% (技术可行 95%, 性能目标 85%, 内存目标 85%)

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

### 3.1 核心决策：Session 生命周期

**选择路线 B：一个画布一个长期 session**

| 对比项     | 路线 A (每 stroke 一个 session) | 路线 B (长期 session) ✅ |
| ---------- | ------------------------------- | ------------------------ |
| 智能清空   | ❌ 无意义                       | ✅ 真正节省 4K 清空      |
| 内存分配   | 每次重新分配 64MB               | 复用 buffer              |
| API 复杂度 | 简单                            | 稍复杂                   |
| 绘画语义   | 不自然                          | 自然（画布=session）     |

**API 设计**：

```
rust_brush_start(width, height)       → 创建长期 session，返回 session_id
rust_brush_begin_stroke(session_id)   → 开始新笔画（智能清空上次 dirty）
rust_brush_input(session_id, ...)     → 流式输入点
rust_brush_end_stroke(session_id)     → 结束笔画（不移除 session）
rust_brush_close(session_id)          → 关闭画布时移除 session
rust_brush_cleanup()                  → 清理超时 session
```

### 3.2 核心语义

- **Session** = 一个画布/图层的 Rust 引擎实例（长期存在）
- **Stroke** = 一次笔画（从 begin 到 end）
- `begin_stroke()` **清理上次 stroke 的 accumulated 区域**（智能清空）
- `end_stroke()` **保存 last_stroke_dirty**（不移除 session）
- `close()` **移除 session**（画布关闭时调用）

### 3.3 双矩形语义

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

### 3.4 数据流

```
┌──────────────────────────────────────────────────────────────────┐
│                        Rust Backend                               │
│                                                                   │
│  Session 生命周期: start ──► [begin → input* → end]* ──► close   │
│                              └────── 多次 stroke ──────┘          │
│                                                                   │
│  ┌─────────────┐    ┌──────────────────┐    ┌─────────────────┐  │
│  │ Input Event │───►│ BrushStamper     │───►│ StreamingEngine │  │
│  │ (x,y,p)     │    │ (existing code)  │    │ (per-session)   │  │
│  └─────────────┘    └──────────────────┘    └─────────────────┘  │
│                                                                   │
│  锁策略: Mutex<ManagerState> + Arc<Mutex<Engine>>                 │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## 4. Review 反馈与修正

### 4.1 v1.6 关键决策

| 决策点               | v1.5             | v1.6              | 理由             |
| -------------------- | ---------------- | ----------------- | ---------------- |
| **session 生命周期** | 每 stroke remove | **长期 session**  | 智能清空才有意义 |
| **mask cache 策略**  | 原始 radius      | **桶中心 radius** | 缓存语义自洽     |
| **字段可见性**       | 私有             | **提供 getter**   | 编译通过         |

### 4.2 v1.7 关键修正：Channel 生命周期与并发模型

#### 4.2.1 问题根因

实测中遇到大量 `[TAURI] Couldn't find callback id` 错误。根因分析：

**风险点 A：前端把 Channel 置空/丢弃时，Rust 仍在 send**

```
序列：
1. 前端连续 processPoints() -> 多个并发 invoke('rust_brush_input')
2. 用户抬笔 -> endStroke() -> this.channel = null
3. 先前未返回的 invoke 在 Rust 侧继续 on_sync.send(data)
4. JS 侧 callback id 已失效 -> 刷 warning
```

**风险点 B：dev HMR/reload 导致所有 callback 失效**

- 旧页面的 Channel 回调 id 全部失效
- Rust 端 async command 继续执行并 send -> 疯狂刷 warning

#### 4.2.2 解决方案

| 优先级 | 问题                 | 解决方案                                         |
| ------ | -------------------- | ------------------------------------------------ |
| P0     | 并发 invoke 时序混乱 | **前端 invoke 串行化 + endStroke 等待队列清空**  |
| P0     | Rust 阻塞 async 线程 | **重 CPU 计算使用 spawn_blocking**               |
| P0     | invoke 频率过高      | **按 rAF 批处理 points（60 invoke/s 而非 200）** |
| P1     | HMR 时残留 send      | **beforeunload 调用 rust_brush_close**           |

#### 4.2.3 输入批处理策略（200Hz 数位板）

| 方案                 | invoke 频率 | 延迟    | 推荐度     |
| -------------------- | ----------- | ------- | ---------- |
| 每点 invoke          | 200/s       | 0ms     | ❌ 不推荐  |
| **按 rAF 批处理** ✅ | ~60/s       | ≤16.7ms | ⭐⭐⭐⭐⭐ |
| 按时间片 8ms         | ~125/s      | ≤8ms    | ⭐⭐⭐     |

参数建议：

- `maxPointsPerBatch`: 16（防极端卡顿积压）
- `flushIntervalMs`: 不需要（rAF 驱动）
- `inFlight`: 串行 promise chain

### 4.3 P1 优化（Phase 0.5 实施）

- bitmap 路径 ImageData 复用
- bitmapChain 定期截断
- `get_sync_data()` 避免 clone（使用 buffer 池）

## 5. 核心实现（v1.6 版）

### 5.1 Rust 端：长期 Session + Getter

```rust
// src-tauri/src/brush/streaming.rs

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::stroke_buffer::Rect;
use super::soft_dab::{render_soft_dab, GaussParams};

/// 内存限制常量
const MAX_BUFFER_SIZE: usize = 80 * 1024 * 1024; // 80MB
const SESSION_TIMEOUT_SECS: u64 = 300; // 5分钟（长期 session）

/// 引擎管理器
pub struct BrushEngineManager {
    pub state: Mutex<ManagerState>,
}

/// 管理器内部状态
pub struct ManagerState {
    engines: HashMap<String, Arc<Mutex<StreamingBrushEngine>>>,
    session_order: VecDeque<String>,
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
    pub fn next_session_id(&mut self) -> String {
        self.session_counter += 1;
        format!("session_{}", self.session_counter)
    }

    pub fn evict_oldest(&mut self) {
        if let Some(oldest_id) = self.session_order.pop_front() {
            self.engines.remove(&oldest_id);
            tracing::info!("[RustBrush] Evicted oldest session: {}", oldest_id);
        }
    }

    pub fn remove_session(&mut self, session_id: &str) {
        self.engines.remove(session_id);
        self.session_order.retain(|id| id != session_id);
        tracing::info!("[RustBrush] Removed session: {}", session_id);
    }

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

    // === 双矩形语义 ===
    sync_dirty_rect: Rect,
    accumulated_dirty_rect: Rect,
    last_stroke_dirty: Rect,

    /// 同步状态
    dab_counter: u32,
    last_sync: Instant,
    last_activity: Instant,
    sync_config: SyncConfig,

    /// Gaussian 参数缓存（量化桶）
    cached_params: Option<GaussParams>,
    cached_params_key: (u32, u32, u32),

    /// Scratch buffer
    output_buffer: Vec<u8>,
}

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

    /// Getter for last_activity (解决跨模块可见性)
    pub fn last_activity(&self) -> Instant {
        self.last_activity
    }

    /// 开始新笔画（智能清空：仅清理上次 stroke 区域）
    pub fn begin_stroke(&mut self) {
        self.last_activity = Instant::now();

        // 智能清空：仅清理上次 stroke 的区域
        if !self.last_stroke_dirty.is_empty() {
            self.clear_rect(&self.last_stroke_dirty);
        }

        // 重置脏区域
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

    /// 结束笔画（不移除 session，保存 dirty 供下次清空）
    pub fn end_stroke(&mut self) {
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
        let radius_bucket = (radius * 50.0).round() as u32;
        let hardness_bucket = (hardness * 100.0) as u32;
        let roundness_bucket = (roundness * 100.0) as u32;
        let key = (radius_bucket, hardness_bucket, roundness_bucket);

        // 使用桶中心半径生成 params（保证缓存语义自洽）
        let quant_radius = radius_bucket as f32 / 50.0;

        let params = if self.cached_params_key == key && self.cached_params.is_some() {
            self.cached_params.as_ref().unwrap()
        } else {
            self.cached_params = Some(GaussParams::new(hardness, quant_radius, roundness));
            self.cached_params_key = key;
            self.cached_params.as_ref().unwrap()
        };

        // 调用现有的 SIMD 渲染函数（使用原始 radius 定位，量化 radius 生成 mask）
        let (left, top, w, h) = render_soft_dab(
            &mut self.buffer,
            self.width as usize,
            self.height as usize,
            cx, cy, radius, // 使用原始 radius 定位中心
            params,
            color,
            flow,
            dab_opacity,
        );

        // 双矩形累加
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

        // 多阈值同步检查
        let elapsed_ms = self.last_sync.elapsed().as_millis() as u32;
        let dirty_bytes = self.sync_dirty_rect_bytes();

        self.dab_counter >= self.sync_config.max_dabs
            || elapsed_ms >= self.sync_config.max_ms
            || dirty_bytes >= self.sync_config.max_bytes
    }

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

    /// 获取脏区域数据（增量同步）
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
            self.output_buffer.reserve(total_size - self.output_buffer.len());
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

        // 清空 sync_dirty_rect（accumulated 保持）
        self.sync_dirty_rect = Rect::empty();
        self.dab_counter = 0;
        self.last_sync = Instant::now();

        Some(self.output_buffer.clone())
    }
}
```

### 5.2 Rust 端：Tauri Commands（长期 session 版本）

```rust
// src-tauri/src/commands.rs

use std::sync::{Arc, Mutex};
use tauri::{State, ipc::Channel};
use crate::brush::streaming::{BrushEngineManager, StreamingBrushEngine};

/// 创建长期 session（画布创建时调用）
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

    let session_id = manager.next_session_id();
    let engine = StreamingBrushEngine::new(width, height)?;

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
    let engine_arc = {
        let manager = state.state.lock().map_err(|e| e.to_string())?;
        manager.get_engine(&session_id)
            .ok_or_else(|| format!("Session not found: {}", session_id))?
    };

    let mut engine = engine_arc.lock().map_err(|e| e.to_string())?;
    engine.begin_stroke();
    Ok(())
}

/// 流式笔刷输入（v1.7: 使用 spawn_blocking 避免阻塞 async runtime）
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
    let engine_arc = {
        let manager = state.state.lock().map_err(|e| e.to_string())?;
        manager.get_engine(&session_id)
            .ok_or_else(|| format!("Session not found: {}", session_id))?
    };

    // v1.7: 重 CPU 计算放入 spawn_blocking，避免阻塞 Tauri async runtime
    // 这解决了 IPC/窗口事件卡顿和并发时序问题
    let sync_data_list = tokio::task::spawn_blocking(move || {
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
        Ok::<_, String>(pending)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {:?}", e))??;

    // Channel send 在 async 上下文中执行（非阻塞）
    for data in sync_data_list {
        if let Err(e) = on_sync.send(data) {
            tracing::error!("[RustBrush] Failed to send sync data: {:?}", e);
        }
    }

    Ok(())
}


/// 结束笔画（不移除 session）
#[tauri::command]
pub fn rust_brush_end_stroke(
    state: State<BrushEngineManager>,
    on_sync: Channel<Vec<u8>>,
    session_id: String,
) -> Result<(), String> {
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

    tracing::debug!("[RustBrush] Ended stroke for session: {}", session_id);
    Ok(())
}

/// 关闭 session（画布关闭时调用）
#[tauri::command]
pub fn rust_brush_close(
    state: State<BrushEngineManager>,
    session_id: String,
) -> Result<(), String> {
    let mut manager = state.state.lock().map_err(|e| e.to_string())?;
    manager.remove_session(&session_id);
    Ok(())
}

/// 清理超时 session（两阶段，避免长时间持锁）
#[tauri::command]
pub fn rust_brush_cleanup(state: State<BrushEngineManager>) -> Result<u32, String> {
    let now = std::time::Instant::now();

    // 阶段 1：收集 Arc
    let engine_arcs: Vec<(String, Arc<Mutex<StreamingBrushEngine>>)> = {
        let manager = state.state.lock().map_err(|e| e.to_string())?;
        manager.engines.iter()
            .map(|(id, arc)| (id.clone(), arc.clone()))
            .collect()
    };

    // 阶段 2：检查超时（try_lock 避免阻塞）
    let mut stale_ids = Vec::new();
    for (id, arc) in engine_arcs {
        if let Ok(engine) = arc.try_lock() {
            if now.duration_since(engine.last_activity()).as_secs() > 300 {
                stale_ids.push(id);
            }
        }
    }

    // 阶段 3：移除超时 session
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
    pub x: f32,
    pub y: f32,
    pub pressure: f32,
}
```

### 5.3 前端：长期 Session 适配（v1.7 修正版）

```typescript
// src/utils/rustBrushReceiver.ts

import { Channel, invoke } from '@tauri-apps/api/core';

type RenderStrategy = 'putImageData' | 'createImageBitmap';

interface SyncMessage {
  data: Uint8Array;
  timestamp: number;
}

/**
 * v1.7 新增：输入调度器
 *
 * 解决的问题：
 * 1. 200Hz 数位板导致 200 invoke/s，过于频繁
 * 2. 并发 invoke 导致 endStroke 时 channel 已清理但 Rust 还在 send
 *
 * 策略：
 * - 按 rAF 批处理 points（~60 invoke/s）
 * - 串行 promise chain 保证同一时刻只有一个 in-flight invoke
 * - endStroke 前先 drain 所有 pending points
 */
class RustInputScheduler {
  private pending: Array<{ x: number; y: number; pressure: number }> = [];
  private rafId: number | null = null;
  private inputChain: Promise<void> = Promise.resolve();
  private strokeToken = 0;
  private maxPointsPerBatch = 16;

  constructor(private invokeInput: (points: any[]) => Promise<void>) {}

  beginStroke(): void {
    this.strokeToken++;
    this.pending = [];
    this.inputChain = Promise.resolve();
    this.startRaf();
  }

  pushPoint(p: { x: number; y: number; pressure: number }): void {
    this.pending.push(p);
    // 防爆队列：极端卡顿时丢中间点，只保留首尾
    if (this.pending.length > 128) {
      const first = this.pending[0];
      const last = this.pending[this.pending.length - 1];
      this.pending = [first, last];
    }
  }

  private startRaf(): void {
    if (this.rafId != null) return;
    const tick = () => {
      this.flushFrame();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopRaf(): void {
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private flushFrame(): void {
    if (this.pending.length === 0) return;

    // 一帧最多发 16 点，剩下留到下一帧
    const batch = this.pending.splice(0, this.maxPointsPerBatch);
    const token = this.strokeToken;

    this.inputChain = this.inputChain.then(async () => {
      if (token !== this.strokeToken) return; // stroke 已切换/结束
      await this.invokeInput(batch);
    });
  }

  async endStrokeAndDrain(): Promise<void> {
    // 停止继续按帧 flush
    this.stopRaf();

    // 把剩余点也发掉
    while (this.pending.length) {
      const batch = this.pending.splice(0, this.maxPointsPerBatch);
      const token = this.strokeToken;
      this.inputChain = this.inputChain.then(async () => {
        if (token !== this.strokeToken) return;
        await this.invokeInput(batch);
      });
    }

    // 等待所有 invoke 完成
    await this.inputChain;
  }
}

export class RustBrushReceiver {
  private channel: Channel<Uint8Array> | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private reusableImageData: ImageData | null = null;
  private sessionId: string = '';
  private isStrokeActive: boolean = false;

  // v1.7: 输入调度器（批处理 + 串行化）
  private scheduler: RustInputScheduler | null = null;
  private currentBrushParams: {
    color: [number, number, number];
    size: number;
    hardness: number;
    roundness: number;
    flow: number;
    opacity: number;
  } | null = null;

  // 消息队列
  private messageQueue: SyncMessage[] = [];
  private rafId: number | null = null;

  // 配置
  private renderStrategy: RenderStrategy = 'putImageData';
  private maxQueueLength: number = 8;

  // Bitmap 串行链
  private bitmapChain: Promise<void> = Promise.resolve();
  private bitmapChainLength: number = 0;

  // 回调
  private compositeCallback: ((strokeCanvas: HTMLCanvasElement) => void) | null = null;
  private fallbackHandler: (() => void) | null = null;

  constructor(options?: {
    onComposite?: (strokeCanvas: HTMLCanvasElement) => void;
    onFallback?: () => void;
    renderStrategy?: RenderStrategy;
  }) {
    this.compositeCallback = options?.onComposite || null;
    this.fallbackHandler = options?.onFallback || null;
    this.renderStrategy = options?.renderStrategy || 'putImageData';
  }

  /** 初始化 session（画布创建时调用一次） */
  async initSession(width: number, height: number): Promise<boolean> {
    try {
      this.sessionId = await invoke<string>('rust_brush_start', { width, height });
      return true;
    } catch (error) {
      console.error('[RustBrush] Failed to init session:', error);
      return false;
    }
  }

  /** 开始笔画（v1.7: 使用调度器实现批处理+串行化） */
  async startStroke(
    ctx: CanvasRenderingContext2D,
    brushParams: {
      color: [number, number, number];
      size: number;
      hardness: number;
      roundness: number;
      flow: number;
      opacity: number;
    }
  ): Promise<boolean> {
    if (!this.sessionId) {
      console.error('[RustBrush] No session, call initSession first');
      return false;
    }

    this.ctx = ctx;
    this.messageQueue = [];
    this.resetBitmapChain();
    this.isStrokeActive = true;
    this.currentBrushParams = brushParams;

    try {
      await invoke('rust_brush_begin_stroke', { sessionId: this.sessionId });

      this.channel = new Channel<Uint8Array>();
      this.channel.onmessage = (data) => this.enqueueMessage(data);

      // v1.7: 初始化输入调度器
      this.scheduler = new RustInputScheduler(async (points) => {
        if (!this.channel || !this.sessionId || !this.currentBrushParams) return;
        await invoke('rust_brush_input', {
          onSync: this.channel,
          sessionId: this.sessionId,
          points,
          ...this.currentBrushParams,
        });
      });
      this.scheduler.beginStroke();

      this.startProcessing();
      return true;
    } catch (error) {
      console.error('[RustBrush] Failed to start stroke:', error);
      this.fallbackToTypescript();
      return false;
    }
  }

  private resetBitmapChain(): void {
    this.bitmapChain = Promise.resolve();
    this.bitmapChainLength = 0;
  }

  private enqueueMessage(data: Uint8Array): void {
    const msg: SyncMessage = { data, timestamp: performance.now() };

    if (this.messageQueue.length >= this.maxQueueLength) {
      const first = this.messageQueue[0];
      this.messageQueue = [first, msg];
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

  private processQueue(): void {
    if (!this.ctx || this.messageQueue.length === 0) return;

    const maxPerFrame = 4;
    const toProcess = this.messageQueue.splice(0, maxPerFrame);

    for (const msg of toProcess) {
      this.handleSync(msg.data);
    }
  }

  private handleSync(data: Uint8Array): void {
    if (!this.ctx) return;

    const view = new DataView(data.buffer, data.byteOffset);
    const left = view.getUint32(0, true);
    const top = view.getUint32(4, true);
    const width = view.getUint32(8, true);
    const height = view.getUint32(12, true);

    if (this.renderStrategy === 'createImageBitmap') {
      this.bitmapChainLength++;

      // 定期截断链（避免无限增长）
      if (this.bitmapChainLength > 100) {
        this.resetBitmapChain();
      }

      this.bitmapChain = this.bitmapChain
        .then(() => this.renderWithBitmap(data, left, top, width, height))
        .catch((err) => {
          console.error('[RustBrush] Bitmap error:', err);
          this.renderStrategy = 'putImageData';
          this.renderWithPutImageData(data, left, top, width, height);
        });
    } else {
      this.renderWithPutImageData(data, left, top, width, height);
    }
  }

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

    const bitmap = await createImageBitmap(imageData, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });

    this.ctx.drawImage(bitmap, left, top);
    bitmap.close();
  }

  /**
   * v1.7: 推送点到调度器（由 rAF 批处理，不直接 invoke）
   *
   * 旧 API processPoints() 被替换，现在只需调用 pushPoint()
   * 调度器会自动按帧批处理并串行化 invoke
   */
  pushPoint(point: { x: number; y: number; pressure: number }): void {
    if (!this.scheduler || !this.isStrokeActive) return;
    this.scheduler.pushPoint(point);
  }

  /** @deprecated 使用 pushPoint() 替代，调度器会自动批处理 */
  async processPoints(
    points: Array<{ x: number; y: number; pressure: number }>,
    _brushParams: {
      color: [number, number, number];
      size: number;
      hardness: number;
      roundness: number;
      flow: number;
      opacity: number;
    }
  ): Promise<void> {
    // v1.7: 兼容旧调用，直接推送到调度器
    if (!this.scheduler || !this.isStrokeActive) return;
    for (const point of points) {
      this.scheduler.pushPoint(point);
    }
  }

  /**
   * v1.7: 结束笔画（先 drain 调度器，确保所有 invoke 完成）
   *
   * 关键修正：在清理 channel 之前先等待所有 pending points 发送完毕
   * 这避免了 "Couldn't find callback id" 错误
   */
  async endStroke(): Promise<void> {
    if (!this.channel || !this.sessionId || !this.isStrokeActive) return;

    try {
      // v1.7 关键：先 drain 调度器，等待所有 invoke 完成
      if (this.scheduler) {
        await this.scheduler.endStrokeAndDrain();
      }

      // 现在安全调用 end_stroke（所有 input invoke 已完成）
      await invoke('rust_brush_end_stroke', {
        onSync: this.channel,
        sessionId: this.sessionId,
      });

      await this.bitmapChain;

      while (this.messageQueue.length > 0) {
        this.processQueue();
        await new Promise((r) => requestAnimationFrame(r));
      }

      if (this.compositeCallback && this.ctx?.canvas) {
        this.compositeCallback(this.ctx.canvas);
      }
    } catch (error) {
      console.error('[RustBrush] End stroke failed:', error);
    } finally {
      this.isStrokeActive = false;
      this.stopProcessing();
      this.scheduler = null;
      this.currentBrushParams = null;
      this.channel = null;
    }
  }

  /** 关闭 session（画布关闭时调用） */
  async closeSession(): Promise<void> {
    if (!this.sessionId) return;

    try {
      await invoke('rust_brush_close', { sessionId: this.sessionId });
    } catch (error) {
      console.error('[RustBrush] Close failed:', error);
    } finally {
      this.sessionId = '';
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
    this.messageQueue = [];
    this.resetBitmapChain();
    this.isStrokeActive = false;
  }

  get isActive(): boolean {
    return this.isStrokeActive;
  }

  get hasSession(): boolean {
    return this.sessionId !== '';
  }

  setRenderStrategy(strategy: RenderStrategy): void {
    this.renderStrategy = strategy;
  }
}
```

## 6. 性能预估（v1.6 版）

### 6.1 端到端延迟

| 阶段                  | 预估值    | 说明                  |
| --------------------- | --------- | --------------------- |
| Rust 计算 (500px dab) | 1.5-2.5ms | SIMD 优化             |
| 构建 + Clone          | 0.5-0.8ms | scratch buffer 复用   |
| Channel 传输          | 0.4-0.6ms | 已验证                |
| putImageData          | 1.0-2.0ms | Edge/Chromium 稳定    |
| **总计**              | 3.4-5.9ms | **目标 < 5ms 可达成** |

### 6.2 智能清空收益

| 场景            | 传统清空    | 智能清空       | 节省    |
| --------------- | ----------- | -------------- | ------- |
| 4K 画布全屏清零 | 64MB = ~5ms | 0              | 5ms     |
| 小笔刷 (100px)  | 同上        | 40KB = ~0.02ms | 近 100% |
| 大笔刷 (500px)  | 同上        | 1MB = ~0.5ms   | 90%     |

### 6.3 置信度评估

| 维度     | v1.5 | v1.6 | v1.7    | 说明                     |
| -------- | ---- | ---- | ------- | ------------------------ |
| 技术可行 | 90%  | 95%  | **95%** | Channel 生命周期修正     |
| 性能目标 | 70%  | 80%  | **85%** | 批处理 + spawn_blocking  |
| 内存目标 | 80%  | 85%  | **85%** | buffer 复用              |
| **总体** | 80%  | 88%  | **90%** | 并发问题解决后置信度提升 |

## 7. 实施路线图（v1.7 版）

### Phase 0.1: 架构基础 (1 天)

- [ ] `Rect` 结构体 + `union()/is_empty()`
- [ ] `ManagerState` + `Arc<Mutex<Engine>>`
- [ ] 双矩形语义实现

### Phase 0.2: 核心实现 (1 天)

- [ ] 智能清空 (`clear_rect`)
- [ ] 量化桶 mask cache（桶中心 radius）
- [ ] 多阈值同步
- [ ] `last_activity()` getter

### Phase 0.3: 前端集成 (0.5 天)

- [ ] 消息队列 + RAF + 丢帧
- [ ] Bitmap 串行链 + 截断
- [ ] 长期 session 生命周期适配

### Phase 0.4: v1.7 并发修正 (0.5 天)

- [ ] `RustInputScheduler` 输入批处理 + 串行化
- [ ] Rust `spawn_blocking` 避免阻塞 async runtime
- [ ] `endStroke` 先 drain 调度器再清理 channel
- [ ] `beforeunload` 事件处理（HMR 场景）

### Phase 0.5: 测试 (1 天)

- [ ] Rust 单元测试
- [ ] 性能基准

### Phase 1: MVP (3 天)

- [ ] 完整 Tauri commands
- [ ] 端到端集成
- [ ] 性能验证

## 8. 验收规则

### 8.1 Session 生命周期

- `initSession` → 多次 (`startStroke` → `input*` → `endStroke`) → `closeSession`
- 智能清空确实节省首个 dab 延迟

### 8.2 双矩形语义

- stamp → sync → stamp → sync 增量发送
- begin_stroke 仅清理 last_stroke_dirty

### 8.3 Mask Cache

- 同一桶内的不同 radius 渲染结果一致（使用桶中心 radius）

## 附录 A: v1.5 → v1.6 关键修正

| 问题                 | 修正                     |
| -------------------- | ------------------------ |
| session 生命周期冲突 | 选择路线 B：长期 session |
| `last_activity` 私有 | 提供 getter              |
| mask cache 不一致    | 使用桶中心 radius        |
| bitmapChain 无限增长 | 定期截断                 |

## 附录 B: v1.6 → v1.7 关键修正

| 问题                              | 修正                                      |
| --------------------------------- | ----------------------------------------- |
| 并发 invoke 导致 callback id 失效 | `RustInputScheduler` 串行化 + 批处理      |
| Rust 阻塞 async runtime           | `tokio::task::spawn_blocking`             |
| endStroke 时 channel 已清理       | 先 `scheduler.endStrokeAndDrain()` 再清理 |
| 200Hz 输入频率过高                | 按 rAF 批处理（~60 invoke/s）             |
| HMR/reload 时疯狂刷 warning       | `beforeunload` 调用 `rust_brush_close`    |

## 附录 C: API 对比

| v1.5                            | v1.6                              | v1.7                                 |
| ------------------------------- | --------------------------------- | ------------------------------------ |
| `rust_brush_end` (移除 session) | `rust_brush_end_stroke` (不移除)  | 同 v1.6                              |
| -                               | `rust_brush_close` (移除 session) | 同 v1.6                              |
| 前端 `processPoints()` 直接调用 | 同 v1.5                           | **`pushPoint()` + 调度器批处理**     |
| -                               | -                                 | **`startStroke()` 接受 brushParams** |

# Rust CPU 笔刷引擎设计方案

> **状态**: 📝 规划中
> **前置条件**: Tauri v2 Channel IPC 测试通过 (Avg Jitter < 0.4ms)
> **目标**: 替代 TypeScript CPU 笔刷，提供高性能 CPU 渲染路径

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
| 500px dab 渲染 | < 2ms       | TS 当前约 10ms |
| IPC 传输延迟   | < 1ms       | 已验证 0.4ms   |
| 首个 dab 延迟  | < 5ms       | 用户感知阈值   |
| 内存占用       | < 50MB 额外 | Stroke Buffer  |

## 3. 架构设计

### 3.1 核心思路

**Rust 端维护完整的 Stroke Buffer**，执行所有像素级计算（Mask + Blending）。仅在需要时通过 Channel 传输 dirty rect 到前端进行 Canvas 显示。

### 3.2 数据流

```
┌──────────────────────────────────────────────────────────────────┐
│                        Rust Backend                               │
│                                                                   │
│  ┌─────────────┐    ┌──────────────────┐    ┌─────────────────┐  │
│  │ Input Event │───►│ BrushStamper     │───►│ RustStrokeBuffer│  │
│  │ (x,y,p)     │    │ (existing code)  │    │                 │  │
│  │             │    │ - Spacing        │    │  ┌───────────┐  │  │
│  │             │    │ - Interpolation  │    │  │ SIMD Mask │  │  │
│  └─────────────┘    └──────────────────┘    │  └─────┬─────┘  │  │
│                                              │        ▼        │  │
│                                              │  ┌───────────┐  │  │
│                                              │  │Alpha Blend│  │  │
│                                              │  └─────┬─────┘  │  │
│                                              └────────┼────────┘  │
│                                                       │           │
│  ┌────────────────────────────────────────────────────▼────────┐  │
│  │ SyncTrigger: N dabs or T ms                                 │  │
│  │ Output: [left, top, w, h, ...pixel_data]                    │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────┬───────────────────────────────┘
                                    │ Tauri v2 Channel (Binary)
                                    │ Avg Latency: ~0.4ms
                                    ▼
┌───────────────────────────────────────────────────────────────────┐
│                        Frontend                                    │
│                                                                   │
│  ┌─────────────────┐    ┌─────────────────┐    ┌───────────────┐  │
│  │ Channel.onMessage│───►│ Parse Header   │───►│ putImageData  │  │
│  │ (Uint8Array)    │    │ (left,top,w,h) │    │ (Canvas2D)    │  │
│  └─────────────────┘    └─────────────────┘    └───────────────┘  │
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
                  ▼ 极端降级
              TypeScript CPU (最后手段)
```

## 4. 现有代码复用分析

### 4.1 可直接复用 ✅

| 文件                     | 功能                              | 复用方式                     |
| ------------------------ | --------------------------------- | ---------------------------- |
| `brush/soft_dab.rs`      | SIMD Gaussian Mask                | 直接调用 `render_soft_dab()` |
| `brush/blend.rs`         | 混合模式 (Normal, Multiply, etc.) | 直接调用                     |
| `brush/stamper.rs`       | 间距计算、Dab 生成                | 直接调用 `BrushStamper`      |
| `brush/stroke_buffer.rs` | Stroke Buffer 结构                | 需扩展以支持 Channel 输出    |
| `bench.rs`               | Channel 发送模式                  | 参考实现                     |

### 4.2 需要新增/修改

| 模块                             | 工作内容                      |
| -------------------------------- | ----------------------------- |
| `brush/streaming.rs` (新)        | Channel 输出逻辑、Sync 策略   |
| `commands.rs`                    | 新增 streaming brush commands |
| 前端 `RustBrushReceiver.ts` (新) | Channel 接收、Canvas 更新     |

## 5. 核心实现

### 5.1 Rust 端：Streaming Stroke Buffer

```rust
// src-tauri/src/brush/streaming.rs

use tauri::ipc::Channel;
use super::{soft_dab::{render_soft_dab, GaussParams}, stroke_buffer::Rect};

/// 流式笔刷引擎状态
pub struct StreamingBrushEngine {
    /// 像素缓冲区 (RGBA, straight alpha)
    buffer: Vec<u8>,
    width: u32,
    height: u32,
    /// 累积脏区域
    dirty_rect: Rect,
    /// 同步计数器
    dab_counter: u32,
    /// 同步间隔 (每 N 个 dab 同步一次)
    sync_interval: u32,
    /// Gaussian 参数缓存 (避免重复计算)
    cached_params: Option<GaussParams>,
    cached_params_key: (u32, u32, u32), // (size*100, hardness*100, roundness*100)
}

impl StreamingBrushEngine {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            buffer: vec![0u8; (width * height * 4) as usize],
            width,
            height,
            dirty_rect: Rect::empty(),
            dab_counter: 0,
            sync_interval: 4, // 与 TS 实现一致
            cached_params: None,
            cached_params_key: (0, 0, 0),
        }
    }

    /// 开始新笔画
    pub fn begin_stroke(&mut self) {
        self.buffer.fill(0);
        self.dirty_rect = Rect::empty();
        self.dab_counter = 0;
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
        // 参数缓存检查
        let key = (
            (radius * 100.0) as u32,
            (hardness * 100.0) as u32,
            (roundness * 100.0) as u32,
        );

        let params = if self.cached_params_key == key {
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

        // 扩展脏区域
        if w > 0 && h > 0 {
            self.dirty_rect.expand(
                (left + w / 2) as i32,
                (top + h / 2) as i32,
                (w.max(h) / 2 + 1) as i32,
            );
        }

        self.dab_counter += 1;
        self.dab_counter >= self.sync_interval
    }

    /// 获取脏区域数据 (用于 Channel 传输)
    /// 格式: [left: u32, top: u32, width: u32, height: u32, ...pixels]
    pub fn get_sync_data(&mut self) -> Option<Vec<u8>> {
        if self.dirty_rect.is_empty() {
            return None;
        }

        let mut rect = self.dirty_rect;
        rect.clamp_to(self.width as i32, self.height as i32);

        let w = (rect.right - rect.left) as u32;
        let h = (rect.bottom - rect.top) as u32;

        if w == 0 || h == 0 {
            return None;
        }

        // Header: 16 bytes (4 x u32)
        let mut data = Vec::with_capacity((16 + w * h * 4) as usize);
        data.extend_from_slice(&(rect.left as u32).to_le_bytes());
        data.extend_from_slice(&(rect.top as u32).to_le_bytes());
        data.extend_from_slice(&w.to_le_bytes());
        data.extend_from_slice(&h.to_le_bytes());

        // Pixels
        for y in rect.top..rect.bottom {
            let start = (y as u32 * self.width + rect.left as u32) as usize * 4;
            let end = start + (w as usize * 4);
            data.extend_from_slice(&self.buffer[start..end]);
        }

        // Reset for next batch
        self.dirty_rect = Rect::empty();
        self.dab_counter = 0;

        Some(data)
    }
}
```

### 5.2 Rust 端：Tauri Command

```rust
// src-tauri/src/commands.rs (新增)

use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::Channel;
use crate::brush::streaming::StreamingBrushEngine;

/// 全局笔刷引擎状态
static BRUSH_ENGINE: OnceLock<Arc<Mutex<StreamingBrushEngine>>> = OnceLock::new();

fn get_brush_engine(width: u32, height: u32) -> Arc<Mutex<StreamingBrushEngine>> {
    BRUSH_ENGINE
        .get_or_init(|| Arc::new(Mutex::new(StreamingBrushEngine::new(width, height))))
        .clone()
}

/// 开始 Rust CPU 笔刷会话
#[tauri::command]
pub fn rust_brush_start(width: u32, height: u32) -> Result<(), String> {
    let engine = get_brush_engine(width, height);
    let mut engine = engine.lock().map_err(|e| e.to_string())?;
    engine.begin_stroke();
    Ok(())
}

/// 流式笔刷输入点
#[tauri::command]
pub async fn rust_brush_input(
    on_sync: Channel<Vec<u8>>,
    points: Vec<BrushInputPoint>,
    color: (u8, u8, u8),
    size: f32,
    hardness: f32,
    roundness: f32,
    flow: f32,
    opacity: f32,
) -> Result<(), String> {
    let engine = get_brush_engine(0, 0); // 使用已初始化的引擎

    for point in points {
        let mut engine = engine.lock().map_err(|e| e.to_string())?;

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
                let _ = on_sync.send(data);
            }
        }
    }

    Ok(())
}

/// 结束笔刷会话并获取最终数据
#[tauri::command]
pub fn rust_brush_end(on_sync: Channel<Vec<u8>>) -> Result<(), String> {
    let engine = get_brush_engine(0, 0);
    let mut engine = engine.lock().map_err(|e| e.to_string())?;

    // 发送剩余脏区域
    if let Some(data) = engine.get_sync_data() {
        let _ = on_sync.send(data);
    }

    Ok(())
}

#[derive(serde::Deserialize)]
pub struct BrushInputPoint {
    x: f32,
    y: f32,
    pressure: f32,
}
```

### 5.3 前端：Channel 接收器

```typescript
// src/utils/rustBrushReceiver.ts

import { Channel, invoke } from '@tauri-apps/api/core';

export class RustBrushReceiver {
  private channel: Channel<Uint8Array> | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private reusableImageData: ImageData | null = null;

  async startStroke(ctx: CanvasRenderingContext2D, width: number, height: number): Promise<void> {
    this.ctx = ctx;

    // 初始化 Rust 端引擎
    await invoke('rust_brush_start', { width, height });

    // 创建 Channel
    this.channel = new Channel<Uint8Array>();
    this.channel.onmessage = (data) => this.handleSync(data);
  }

  private handleSync(data: Uint8Array): void {
    if (!this.ctx) return;

    // 解析 header (16 bytes)
    const view = new DataView(data.buffer, data.byteOffset);
    const left = view.getUint32(0, true);
    const top = view.getUint32(4, true);
    const width = view.getUint32(8, true);
    const height = view.getUint32(12, true);

    // 复用 ImageData 避免分配
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
    if (!this.channel) return;

    await invoke('rust_brush_input', {
      onSync: this.channel,
      points,
      ...brushParams,
    });
  }

  async endStroke(): Promise<void> {
    if (!this.channel) return;

    await invoke('rust_brush_end', { onSync: this.channel });
    this.channel = null;
    this.ctx = null;
  }
}
```

## 6. 性能预估

### 6.1 计算对比

| 操作                | TypeScript | Rust SIMD | 提升倍数 |
| ------------------- | ---------- | --------- | -------- |
| Mask 生成 (100px)   | ~2ms       | ~0.1ms    | **20x**  |
| Alpha Blend (100px) | ~3ms       | ~0.2ms    | **15x**  |
| **Dab 总计**        | ~5ms       | ~0.3ms    | **17x**  |

### 6.2 端到端延迟预估

| 阶段                   | 耗时   | 累计      |
| ---------------------- | ------ | --------- |
| Rust 计算 (500px dab)  | ~1.5ms | 1.5ms     |
| Sync 准备 (提取脏区域) | ~0.3ms | 1.8ms     |
| Channel 传输           | ~0.4ms | 2.2ms     |
| putImageData           | ~0.5ms | **2.7ms** |

对比 TypeScript 500px dab 约 **10-15ms**，预计提速 **4-5 倍**。

## 7. 实施路线图

### Phase 1: 基础框架 (1-2 天)

- [ ] 创建 `brush/streaming.rs`
- [ ] 实现 `StreamingBrushEngine` 基础结构
- [ ] 添加 Tauri commands
- [ ] 前端 `RustBrushReceiver` 基础实现

### Phase 2: 集成测试 (1 天)

- [ ] 连通 Input → Rust → Canvas 完整链路
- [ ] 性能基准测试
- [ ] 与 TypeScript 实现 A/B 对比

### Phase 3: 功能完善 (2-3 天)

- [ ] 硬笔刷快速路径 (跳过 Gaussian)
- [ ] 纹理笔刷支持 (从 ABR 导入)
- [ ] Wet Edge 效果
- [ ] 混合模式扩展

### Phase 4: 优化与稳定 (1-2 天)

- [ ] Mask 缓存 (参数容差策略)
- [ ] 性能分析与瓶颈优化
- [ ] 边界情况测试

## 8. 风险与缓解

| 风险                 | 影响     | 缓解策略                    |
| -------------------- | -------- | --------------------------- |
| Channel 高负载下抖动 | 预览卡顿 | 动态调整 sync_interval      |
| 大脏区域传输慢       | 延迟增加 | 分块传输、只传增量          |
| 内存占用过高         | OOM      | 限制 buffer 尺寸、使用 Tile |

## 9. 与其他文档关系

- **废弃**: `rust-brush-engine-revival.md` (该方案面向 GPU，本方案面向 CPU)
- **参考**: `soft-brush-performance-optimization.md` (优化经验)
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

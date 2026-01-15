# 抬笔闪烁问题调研与修复计划

> **日期**: 2026-01-15
> **状态**: 调研完成，待实施
> **优先级**: P1
> **关联**: [gpu-rendering-fix-plan.md](./gpu-rendering-fix-plan.md)

---

## 问题概述

| 项目     | 描述                                                                      |
| -------- | ------------------------------------------------------------------------- |
| 现象     | 画完一笔抬起笔时，画面出现短暂闪烁（笔触消失后又出现，或颜色/透明度跳变） |
| 影响范围 | 仅 GPU 渲染模式                                                           |
| 复现条件 | 任意笔刷参数，低 Flow 时更明显                                            |

---

## 根因分析

### 数据流追踪

#### 绘制中 (Preview 阶段)

```
handlePointerMove
  → processBrushPointWithConfig(x, y, pressure)
    → gpuBuffer.stampDab(params)
      → flushBatch() [达到阈值时]
        → GPU 渲染 (per-dab loop with Ping-Pong)
        → previewNeedsUpdate = true
        → updatePreview() [异步 readback]
    → compositeAndRenderWithPreview()
      → layerRenderer.composite({ preview: previewCanvas })
      → 显示到主 canvas
```

#### 抬笔时 (endStroke 阶段)

```
handlePointerUp
  → finishCurrentStroke()
    → endBrushStroke(layerCtx)
      → gpuBuffer.endStroke(layerCtx, opacity)
        → flushBatch() [提交剩余 dab]
        → await device.queue.onSubmittedWorkDone()
        → await waitForPreviewReady()
          → while (previewUpdatePending || previewNeedsUpdate) { wait }
          → await updatePreviewSync()  ← 问题点 1
        → compositeFromPreview(layerCtx, opacity)
    → compositeAndRender()  ← 问题点 2: 不含 preview
```

### 问题点详解

#### 问题 1: 异步 readback 竞态条件

```typescript
// GPUStrokeAccumulator.ts

// 绘制中使用的异步 preview 更新
private async updatePreview(): Promise<void> {
  // 使用 previewReadbackBuffer
  await this.previewReadbackBuffer.mapAsync(GPUMapMode.READ);
  // ... 读取数据到 previewCanvas
}

// endStroke 中使用的同步 preview 更新
private async updatePreviewSync(): Promise<void> {
  // 也使用同一个 previewReadbackBuffer!
  await this.previewReadbackBuffer.mapAsync(GPUMapMode.READ);
  // ... 读取数据到 previewCanvas
}
```

**风险**: 如果 `updatePreview()` 正在执行（buffer 已 mapped），`updatePreviewSync()` 会失败或产生不一致数据。

#### 问题 2: 渲染内容跳变

```
绘制最后一帧:
  compositeAndRenderWithPreview() → 显示 [图层 + previewCanvas]

抬笔:
  compositeFromPreview() → 将 previewCanvas 合成到图层
  compositeAndRender() → 显示 [图层] (不含 preview)
```

**理论上应该一致**，但如果：

1. `updatePreviewSync()` 读取的数据与之前 `updatePreview()` 不完全同步
2. `compositeFromPreview()` 的合成逻辑与 `layerRenderer.composite(preview)` 有细微差异
3. readback 时机问题导致数据不完整

就会产生视觉跳变。

#### 时序图示

```
时间 ─────────────────────────────────────────────────────────►

绘制中:
GPU渲染  ████████████████████████████████████
updatePreview (异步)  ░░░░░  ░░░░░  ░░░░░  [可能仍在执行]
显示 (with preview)   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓

抬笔时:                                        ↓PointerUp
flushBatch                                     ██
onSubmittedWorkDone                            ──wait──
waitForPreviewReady                                   ──wait──
updatePreviewSync                                           ██
compositeFromPreview                                          ██
compositeAndRender (无preview)                                   ▓▓

闪烁窗口 ───────────────────────────────────────────────────────►
                                              最后 preview → 无 preview → 图层已合成
```

---

## 修复方案对比

### 方案 A: 复用最后一帧 preview 数据 (推荐 ⭐)

**核心思想**: 确保 endStroke 使用的数据与最后一帧 preview 完全一致，不做额外 readback。

```typescript
// GPUStrokeAccumulator.ts - endStroke 修改

async endStroke(layerCtx: CanvasRenderingContext2D, opacity: number): Promise<Rect> {
  // 1. 提交最后的 dab
  this.flushBatch();

  // 2. 等待 GPU 完成
  await this.device.queue.onSubmittedWorkDone();

  // 3. 等待任何正在进行的 preview 更新完成（不触发新的 readback）
  while (this.previewUpdatePending) {
    await new Promise(r => setTimeout(r, 1));
  }

  // 4. 确保最后一批 dab 的 preview 已更新
  if (this.previewNeedsUpdate) {
    await this.updatePreview();
  }

  // 5. 直接使用当前 previewCanvas（与用户看到的完全一致）
  this.compositeFromPreview(layerCtx, opacity);

  this.active = false;
  return this.getDirtyRect();
}
```

#### 优化 1: Promise 等待 + Buffer 状态守卫

使用 `while + setTimeout` 是一种"自旋锁"式写法，可能引入 1ms-4ms 不确定延迟。改用 Promise 存储，并增加 **mapState 检查** 防止极速点击时的冲突：

```typescript
private currentPreviewPromise: Promise<void> | null = null;

private async updatePreview() {
  // 1. 如果已经在运行，直接返回现有的 Promise
  if (this.currentPreviewPromise) return this.currentPreviewPromise;

  // 2. 关键：检查 Buffer 状态，防止重复 map
  if (this.previewReadbackBuffer.mapState !== 'unmapped') {
    console.warn('Buffer is not unmapped, skipping update');
    return;
  }

  this.currentPreviewPromise = (async () => {
    try {
      await this.previewReadbackBuffer.mapAsync(GPUMapMode.READ);
      // ... copy data ...
      this.previewReadbackBuffer.unmap();
    } catch (e) {
      console.error('MapAsync failed:', e);
      // 出错时标记需要重试，或降级处理
    } finally {
      this.currentPreviewPromise = null;
      this.previewUpdatePending = false;
    }
  })();

  await this.currentPreviewPromise;
}

// endStroke 中直接 await
if (this.currentPreviewPromise) {
  await this.currentPreviewPromise;
}
```

#### 优化 2: 原子化事务提交

> [!WARNING]
> **时序漏洞**: 如果在 `await endStroke()` 和 `requestAnimationFrame` 之间浏览器插入一次 Paint，用户会看到"双重叠加"（Layer + Preview 同时显示，画面变深）。

**解决方案**: 将 `endStroke` 拆分为异步准备 + 同步提交，确保 **"合成到 Layer"** 和 **"清空 Preview"** 在同一个同步代码块内执行：

```typescript
// GPUStrokeAccumulator.ts - 拆分为两步
async prepareEndStroke(): Promise<void> {
  // 1. 提交最后的 dab
  this.flushBatch();
  await this.device.queue.onSubmittedWorkDone();

  // 2. 等待 preview 更新完成（异步部分在这里结束）
  if (this.currentPreviewPromise) {
    await this.currentPreviewPromise;
  }
  if (this.previewNeedsUpdate) {
    await this.updatePreview();
  }
}

compositeToLayer(layerCtx: CanvasRenderingContext2D, opacity: number): Rect {
  // 同步操作：合成到图层，返回脏区
  this.compositeFromPreview(layerCtx, opacity);
  this.active = false;
  return this.getDirtyRect();
}

// Canvas/index.tsx 调用层
const handlePointerUp = async () => {
  // 1. 异步等待 GPU 准备好数据 (Preview 仍可见，Layer 未更新)
  await strokeAccumulator.prepareEndStroke();

  // 2. 核心事务：同步执行，不可分割，中间无 await
  const dirtyRect = strokeAccumulator.compositeToLayer(layerCtx, opacity);
  strokeAccumulator.clear();

  // 3. 通知重绘
  renderLayer(dirtyRect);
};
```

_这样做确保在任何时刻，画面要么是 "Preview 模式"，要么是 "Layer 模式"，绝不会出现中间态。_

#### 优化 3: Context Lost 防御

在 `await` 异步操作期间，设备可能丢失（显存压力大时）：

```typescript
async endStroke(...) {
  if (this.device.lost) {
    console.warn('GPU device lost during endStroke');
    return this.getDirtyRect(); // 降级处理
  }
  // ...
}
```

| 优点                    | 缺点                          |
| ----------------------- | ----------------------------- |
| 简单，减少一次 readback | 依赖 updatePreview() 正确执行 |
| 保证 WYSIWYG            | -                             |
| 无额外内存开销          | -                             |

### 方案 B: 双缓冲 readback buffer

**核心思想**: 使用两个独立的 readback buffer，彻底消除竞态。

```typescript
private previewReadbackBuffer: GPUBuffer;    // 用于异步 preview
private compositeReadbackBuffer: GPUBuffer;  // 用于 endStroke
```

| 优点             | 缺点                          |
| ---------------- | ----------------------------- |
| 彻底消除竞态条件 | 增加 ~50MB GPU 内存 (4K 画布) |
| 代码逻辑清晰     | 需要维护两套 buffer           |

### 方案 C: 帧边界同步

**核心思想**: 在抬笔时插入完整渲染帧，确保 preview 和 composite 在同一帧。

```typescript
async endStroke(...) {
  this.flushBatch();
  await this.device.queue.onSubmittedWorkDone();
  await this.updatePreviewSync();

  // 等待一帧，确保用户看到最终 preview
  await new Promise(r => requestAnimationFrame(r));

  this.compositeFromPreview(layerCtx, opacity);
}
```

| 优点           | 缺点                     |
| -------------- | ------------------------ |
| 用户体验最平滑 | 增加 16ms 延迟           |
| 理论上最正确   | 快速连续笔触可能累积延迟 |

---

## 实施计划

### Phase 1: 诊断验证 (30 min)

- [ ] 添加调试日志，记录 `updatePreview()` 和 `updatePreviewSync()` 的调用时序
- [ ] 确认闪烁的具体表现（消失、颜色跳变、位置偏移）
- [ ] 对比 CPU 模式是否有同样问题（预期没有）

### Phase 2: 实施方案 A (2 hour)

- [ ] **核心修复**: 拆分 `endStroke()` 为 `prepareEndStroke()` + `compositeToLayer()`
- [ ] 移除 `updatePreviewSync()` 调用
- [ ] **优化 1**: Promise 等待 + Buffer 状态守卫
  - 添加 `currentPreviewPromise` 字段
  - 重构 `updatePreview()` 存储 Promise 并检查 `mapState`
  - 添加 try-catch 错误处理
- [ ] **优化 2**: 原子化事务提交
  - 修改调用层使用 `prepareEndStroke()` + 同步 `compositeToLayer()` + `clear()`
  - 确保三步操作在同一同步代码块内，中间无 await
- [ ] **优化 3**: Context Lost 防御
  - 添加 `device.lost` 检查
- [ ] 添加防御性检查确保 `previewCanvas` 数据有效

### Phase 3: 验证 (1 hour)

- [ ] 手动测试各种笔刷参数
- [ ] 快速连续笔触测试（10 笔/秒）
- [ ] **极速点按测试**（像啄木鸟一样快速点击）
  - 不应出现 `mapAsync` 报错
  - 不应出现笔触丢失
  - 不应出现闪烁
- [ ] **坐标对齐测试**
  - 画 1px 细线，放大观察抬笔瞬间是否变模糊或移动
  - 如有抖动，检查 `compositeFromPreview` 的 `drawImage` 坐标是否取整 (`Math.floor`)
- [ ] 不同图层绘制测试
- [ ] 低 Flow (0.1) + 高 Opacity (1.0) 边界测试

---

## 关键文件

| 文件                                        | 修改内容                                                          |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `src/gpu/GPUStrokeAccumulator.ts`           | 拆分 `endStroke()` 为 `prepareEndStroke()` + `compositeToLayer()` |
| `src/components/Canvas/useBrushRenderer.ts` | 修改调用链，使用新的两步 API                                      |
| `src/components/Canvas/index.tsx`           | 验证事件处理的时序正确性                                          |

---

## 验证标准

| 测试项         | 通过标准                 |
| -------------- | ------------------------ |
| 单次笔触       | 抬笔无闪烁               |
| 快速连续笔触   | 多次抬笔均无闪烁         |
| 低 Flow (0.1)  | 累积效果正确，抬笔无跳变 |
| 大笔刷 (500px) | 性能无明显下降           |
| 多图层         | 各图层抬笔均无闪烁       |
| CPU 模式对比   | 两种模式抬笔行为一致     |

---

## 参考

- [gpu-rendering-fix-plan.md](./gpu-rendering-fix-plan.md) - GPU 渲染整体修复计划
- [gpu-brush-rendering-issues.md](../postmortem/gpu-brush-rendering-issues.md) - 问题详细分析

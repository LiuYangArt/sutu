# 抬笔闪烁问题调研与修复计划

> **日期**: 2026-01-15
> **状态**: 📦 已归档 / 实时监控中
> **结论**: 经 Phase 3 工具集深度验证，现有状态机已解决该问题，暂不实施进一步修改。
> **优先级**: P1
> **关联**: [gpu-rendering-fix-plan.md](./gpu-rendering-fix-plan.md)

---

## 问题概述

| 项目       | 描述                                                                      |
| ---------- | ------------------------------------------------------------------------- |
| 现象       | 画完一笔抬起笔时，画面出现短暂闪烁（笔触消失后又出现，或颜色/透明度跳变） |
| 影响范围   | 仅 GPU 渲染模式                                                           |
| 复现条件   | 任意笔刷参数，低 Flow 时更明显                                            |
| **新问题** | **Phase 2.5 后仍存在：偶尔笔触画不出来、方块闪一下**                      |

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

#### 问题 3: 笔触偶尔丢失（方案 A 实施后发现）

**现象**: 画完笔触后偶尔丢失整个笔触，画布上没有任何痕迹。

**根因分析**:

`compositeToLayer()` 中有 `!this.active` 检查会提前返回：

```typescript
compositeToLayer(layerCtx: CanvasRenderingContext2D, opacity: number): Rect {
  if (!this.active) {
    return { left: 0, top: 0, right: 0, bottom: 0 };  // 跳过合成！
  }
  // ...
}
```

**竞态条件场景**：

1. 用户抬笔，调用 `await gpuBuffer.prepareEndStroke()`
2. 在 `await` 期间，用户快速开始新笔触
3. `beginStroke()` → `clear()` → `this.active = false`
4. `prepareEndStroke()` 完成后，`compositeToLayer()` 因 `!this.active` 跳过合成
5. 第一笔触丢失

#### 问题 4: 方块残留（方案 A 实施后发现）

**现象**: 在抬笔位置留下一个矩形方块，而不是完整的笔触。

**根因分析**:

`updatePreview()` 中的 buffer 状态守卫会跳过更新：

```typescript
if (this.previewReadbackBuffer.mapState !== 'unmapped') {
  console.warn('[GPUStrokeAccumulator] Buffer is not unmapped, skipping update');
  return; // 跳过更新，previewCanvas 数据不完整！
}
```

当 buffer 正在 map 时：

1. `updatePreview()` 跳过，没有创建 `currentPreviewPromise`
2. `prepareEndStroke()` 中 `if (this.currentPreviewPromise)` 不成立，不等待
3. `previewNeedsUpdate` 可能为 false（被之前跳过的调用清除）
4. `compositeFromPreview()` 使用不完整的 previewCanvas 数据
5. 结果：只有部分脏区有数据，显示为方块

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

### 验证记录 (2026-01-15) ✅

- **自动化测试**: `e2e/stroke-flicker.spec.ts` 运行 100% 通过（含 100x 极速点击）。
- **遥测数据**: 无 `point_dropped`，无 `long_starting`。
- **决策**: 鉴于无法复现，Phase 2.7 以上的额外优化策略（如方案 B/C）转为技术储备，暂不合入主分支。

---

## 修复方案对比

### 方案 A: 复用最后一帧 preview 数据 (推荐 ⭐) ✅ 已实施

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

#### 优化 1: Promise 等待 + Buffer 状态守卫 ✅ 已实施

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

#### 优化 2: 原子化事务提交 ✅ 已实施

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

#### 优化 3: Context Lost 防御 ✅ 已实施

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

#### 优化 4: 修复问题 3 - 移除 compositeToLayer 中的 active 检查

由于 `compositeToLayer` 只在 `prepareEndStroke` 之后同步调用，调用层保证正确性，不需要再检查 active 状态：

```typescript
compositeToLayer(layerCtx: CanvasRenderingContext2D, opacity: number): Rect {
  // 移除 if (!this.active) 检查
  // 调用层保证在 prepareEndStroke 后立即同步调用

  this.compositeFromPreview(layerCtx, opacity);
  this.active = false;
  return { ... };
}
```

#### 优化 5: 修复问题 4 - updatePreview 在 buffer 忙时标记需要重试

当 buffer 正在 map 时，不应该静默跳过，而应该标记需要重试：

```typescript
private async updatePreview(): Promise<void> {
  if (this.currentPreviewPromise) {
    return this.currentPreviewPromise;
  }

  if (!this.previewReadbackBuffer) {
    return;
  }

  // 修复：如果 buffer 正在 map，标记需要重试而非跳过
  if (this.previewReadbackBuffer.mapState !== 'unmapped') {
    console.warn('[GPUStrokeAccumulator] Buffer is not unmapped, will retry');
    this.previewNeedsUpdate = true;  // 确保下次会重试
    return;
  }

  // ... 其余逻辑不变
}
```

#### 优化 6: prepareEndStroke 强制执行 updatePreview

确保 `prepareEndStroke` 始终等待 preview 数据完整：

```typescript
async prepareEndStroke(): Promise<void> {
  // ... 现有逻辑 ...

  // 修复：始终执行 updatePreview 确保数据完整
  // 即使 previewNeedsUpdate 为 false，也要确保最后一批 dab 已经 readback
  await this.updatePreview();
}
```

#### 优化 7: 渲染锁防止"追尾"（关键！）

> [!IMPORTANT]
> **Review 发现的深层竞态问题**：即使移除了 `!this.active` 检查，如果 Stroke 2 在 Stroke 1 的 `await prepareEndStroke()` 期间开始，Stroke 2 的 `clear()` 会清空 `previewCanvas`，导致 Stroke 1 合成空白画布。

**场景时序**：

```
Stroke 1: await prepareEndStroke() → [等待 GPU readback...]
Stroke 2: handlePointerDown → beginStroke() → clear() → 清空 previewCanvas!
Stroke 1: compositeToLayer() → 合成的是空白画布 → 笔触丢失
```

**解决方案**：在调用层添加"渲染锁"，确保上一笔完成前不能开始新笔：

```typescript
// useBrushRenderer.ts 或 Canvas/index.tsx

let finishingPromise: Promise<void> | null = null;

const handlePointerDown = async (e) => {
  // 防止"追尾"：如果上一笔还在收尾，等它做完再开始新的一笔
  if (finishingPromise) {
    await finishingPromise;
  }

  brush.beginStroke(e);
};

const handlePointerUp = async () => {
  // 创建一个锁 Promise
  finishingPromise = (async () => {
    try {
      await brush.prepareEndStroke();
      // 此时已拿到数据，进入同步提交阶段
      brush.compositeToLayer();
      brush.clear();
      render();
    } finally {
      finishingPromise = null;
    }
  })();

  await finishingPromise;
};
```

#### 优化 8: Buffer 状态死锁防御

**隐患**：如果 Buffer 因异常一直处于 `mapped` 状态，`updatePreview` 会直接返回，`prepareEndStroke` 认为完事了但实际没读到数据。

**解决方案**：`updatePreview` 在 buffer 忙时应该等待现有 Promise，而不是放弃：

```typescript
private async updatePreview(): Promise<void> {
  // 1. 如果正在进行中，直接复用 Promise (最高效的等待)
  if (this.currentPreviewPromise) {
    return this.currentPreviewPromise;
  }

  // 2. 如果已经 mapped 但没有 promise (理论不该发生)，尝试 unmap
  if (this.previewReadbackBuffer.mapState === 'mapped') {
    try {
      this.previewReadbackBuffer.unmap();
    } catch {
      // 忽略 unmap 错误
    }
  }

  // 3. 如果是 pending 状态，标记需要重试
  if (this.previewReadbackBuffer.mapState !== 'unmapped') {
    this.previewNeedsUpdate = true;
    return;
  }

  // 4. 正常流程 ...
}
```

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

### Phase 1: 诊断验证 (30 min) ✅ 已完成

- [x] 添加调试日志，记录 `updatePreview()` 和 `updatePreviewSync()` 的调用时序
- [x] 确认闪烁的具体表现（消失、颜色跳变、位置偏移）
- [x] 对比 CPU 模式是否有同样问题（预期没有）

### Phase 2: 实施方案 A (2 hour) ✅ 已完成

- [x] **核心修复**: 拆分 `endStroke()` 为 `prepareEndStroke()` + `compositeToLayer()`
- [x] 移除 `updatePreviewSync()` 调用
- [x] **优化 1**: Promise 等待 + Buffer 状态守卫
  - 添加 `currentPreviewPromise` 字段
  - 重构 `updatePreview()` 存储 Promise 并检查 `mapState`
  - 添加 try-catch 错误处理
- [x] **优化 2**: 原子化事务提交
  - 修改调用层使用 `prepareEndStroke()` + 同步 `compositeToLayer()` + `clear()`
  - 确保三步操作在同一同步代码块内，中间无 await
- [x] **优化 3**: Context Lost 防御
  - 添加 `device.lost` 检查
- [x] 添加防御性检查确保 `previewCanvas` 数据有效

### Phase 2.5: 修复新发现的问题 (1 hour) ✅ 已完成

> 实施方案 A 后发现笔触丢失和方块残留问题

- [x] **优化 4**: 移除 `compositeToLayer` 中的 `!this.active` 检查
  - 调用层保证正确性，不需要再检查 active 状态
- [x] **优化 5**: `updatePreview` 在 buffer 忙时标记需要重试
  - 设置 `this.previewNeedsUpdate = true` 而非静默跳过
- [x] **优化 6**: `prepareEndStroke` 始终执行 `updatePreview`
  - 即使 `previewNeedsUpdate` 为 false 也要确保数据完整
- [x] **优化 7**: 添加"渲染锁"防止追尾（关键！）
  - 在 `useBrushRenderer` 中添加 `finishingPromise` 锁
  - `beginStroke` 前等待上一笔完成
  - 确保 Stroke 2 的 `clear()` 不会清空 Stroke 1 的数据
- [x] **优化 8**: Buffer 状态死锁防御
  - 如果 buffer 是 `mapped` 状态但没有 promise，尝试 unmap

### Phase 2.6: 修复 Canvas 层竞态 ✅ 已完成

> Phase 2.5 实施后仍存在问题：偶尔笔触画不出来、方块闪一下

#### 问题分析

**根本原因**：`Canvas/index.tsx` 中 `handlePointerDown` 使用 fire-and-forget 异步调用：

```typescript
// 当前代码 - 有问题
(async () => {
  await beginBrushStroke(brushHardness);
  processBrushPointWithConfig(canvasX, canvasY, pressure);
})();
```

**竞态场景**：

1. **"方块闪一下"**：上一笔还在 `prepareEndStroke`（准备合成），新的一笔 `beginStroke` -> `clear()` 已经执行。上一笔合成时发现 Preview 被清空，导致闪烁。
2. **"笔触丢失"**：快速点击触发两次 Handler，并发执行导致某个点被丢弃。
3. **"死锁/卡死"**：如果 `beginStroke` 报错（如 Context Lost），且没有 catch，后续点击因为等待锁而无限挂起。

#### 修复方案

**优化 9: 提升锁到 Canvas 层 (带错误处理)** ✅ 已实施

在 `Canvas/index.tsx` 中添加 `beginStrokePromise` 锁，并增加 `try-catch` 防止死锁：

```typescript
// Canvas/index.tsx
const beginStrokePromiseRef = useRef<Promise<void> | null>(null);

const handlePointerDown = useCallback(
  async (e: React.PointerEvent) => {
    // ... 前置逻辑 ...

    if (currentTool === 'brush') {
      const previousPromise = beginStrokePromiseRef.current;

      const currentTask = (async () => {
        try {
          // 1. 等待上一个任务完成（无论成功失败，防止死锁）
          if (previousPromise) {
            await previousPromise.catch((e) => console.warn('Previous stroke failed:', e));
          }

          // 2. 执行当前任务
          await beginBrushStroke(brushHardness);

          // 3. 只有 begin 成功后才处理点，确保时序正确
          processBrushPointWithConfig(canvasX, canvasY, pressure);
        } catch (error) {
          console.error('Failed to start stroke:', error);
          // 可选：重置状态或降级处理
        }
      })();

      // 形成链条
      beginStrokePromiseRef.current = currentTask;

      // 等待当前任务（虽然事件处理本身不阻塞，但这保证逻辑串行）
      await currentTask;
    }
  },
  [beginBrushStroke, processBrushPointWithConfig, brushHardness]
);
```

**优化 10: 串行化 PointerUp (防止追尾)** ✅ 已实施

确保 `PointerUp` 不会在 `PointerDown` 完成前执行，防止 "No active stroke" 错误：

```typescript
const handlePointerUp = useCallback(
  async (e: React.PointerEvent) => {
    // 关键：确保 PointerDown 的逻辑全部跑完
    if (beginStrokePromiseRef.current) {
      await beginStrokePromiseRef.current;
    }

    finishCurrentStroke();
  },
  [finishCurrentStroke]
);
```

**优化 11: 添加调试日志**

在关键位置添加日志，用于验证锁机制是否生效及排查死锁：

```typescript
// useBrushRenderer.ts
const beginStroke = useCallback(async (hardness: number = 100): Promise<void> => {
  console.log(`[useBrushRenderer] beginStroke START`);
  // ...
```

### Phase 2.7: 修复 PointerMove 竞态 ✅ 已完成

> Phase 2.6 实施后测试发现：快速频繁下笔时仍偶尔出现笔触丢失

#### 问题分析

**根因**：`handlePointerMove` 不等待 `beginStrokePromise` 完成就调用 `processBrushPointWithConfig`。

**竞态时序**：

```
t0: PointerDown_1 → isDrawingRef = true
t1: beginStrokePromiseRef = task_1 (等待上一笔 finishingPromise)
t2: PointerMove_1 触发
t3: isDrawingRef.current = true → 检查通过！
t4: processBrushPointWithConfig()
t5: gpuBuffer.stampDab() → if (!this.active) return; → 点丢失！
    (因为 task_1 还在等待，beginStroke 未执行，this.active = false)
```

**关键代码路径**：

```typescript
// GPUStrokeAccumulator.ts
stampDab(params: GPUDabParams): void {
  if (!this.active) return;  // ← 问题点：stroke 未开始时直接丢弃
  ...
}

// Canvas/index.tsx - handlePointerMove
if (!isDrawingRef.current) return;
// 没有等待 beginStrokePromise！
if (currentTool === 'brush') {
  processBrushPointWithConfig(canvasX, canvasY, pressure);  // ← 可能在 beginStroke 完成前执行
}
```

**问题场景**：

1. 用户快速连续点击
2. Stroke 1 的 finishingPromise 还在执行
3. Stroke 2 的 PointerDown 设置 `isDrawingRef = true`，但 `beginStroke` 在等待
4. Stroke 2 的 PointerMove 通过 `isDrawingRef` 检查
5. `stampDab` 因 `!this.active` 丢弃点

#### 修复方案

> [!IMPORTANT]
> **Review 建议**：不要继续加锁，而是使用 **状态机 + 输入缓冲**。加锁只能缓解问题，真正需要的是事件与 Stroke 生命周期的对齐。

**优化 12: 状态机 + 输入缓冲 (推荐方案)**

**核心思路**：

1. Stroke 有明确状态：`Idle → Starting → Active → Finishing → Idle`
2. 在 `Starting` 阶段，把所有点先缓存起来，不丢给 GPU（因为 active 还没 true）
3. `beginBrushStroke()` 完成后：进入 `Active`，回放缓存点
4. 如果 `PointerUp` 在 `Starting` 阶段就来了：标记 `pendingEnd`，等 begin 完成后立刻走 `endStroke`

**实现方案**：

```typescript
// Canvas/index.tsx 或 useBrushRenderer.ts

// 1. 定义状态类型
type StrokeState = 'idle' | 'starting' | 'active' | 'finishing';

// 2. 新增 Ref
const strokeStateRef = useRef<StrokeState>('idle');
const pendingPointsRef = useRef<Array<{ x: number; y: number; pressure: number }>>([]);
const pendingEndRef = useRef(false);  // 标记是否在 Starting 阶段收到 PointerUp

// 3. handlePointerDown 修改
const handlePointerDown = useCallback((e: React.PointerEvent) => {
  // ... 前置逻辑 ...

  if (currentTool === 'brush') {
    // 进入 Starting 状态
    strokeStateRef.current = 'starting';
    pendingPointsRef.current = [];  // 清空缓冲
    pendingEndRef.current = false;

    // 缓存第一个点
    pendingPointsRef.current.push({ x: canvasX, y: canvasY, pressure });

    // 异步开始笔触
    (async () => {
      try {
        await beginBrushStroke(brushHardness);

        // 进入 Active 状态
        strokeStateRef.current = 'active';

        // 回放所有缓存的点
        for (const pt of pendingPointsRef.current) {
          processBrushPointWithConfig(pt.x, pt.y, pt.pressure);
        }
        pendingPointsRef.current = [];

        // 如果在 Starting 阶段就收到了 PointerUp，立即结束
        if (pendingEndRef.current) {
          await finishCurrentStroke();
        }
      } catch (error) {
        console.error('[Canvas] Failed to start stroke:', error);
        strokeStateRef.current = 'idle';
      }
    })();
  }
}, [...]);

// 4. handlePointerMove 修改
const handlePointerMove = useCallback((e: React.PointerEvent) => {
  // ... 前置逻辑 ...

  if (currentTool === 'brush') {
    if (strokeStateRef.current === 'starting') {
      // Starting 阶段：缓存点，稍后回放
      pendingPointsRef.current.push({ x: canvasX, y: canvasY, pressure });
    } else if (strokeStateRef.current === 'active') {
      // Active 阶段：正常处理
      processBrushPointWithConfig(canvasX, canvasY, pressure);
    }
    // idle/finishing 阶段：忽略
    continue;
  }
}, [...]);

// 5. handlePointerUp 修改
const handlePointerUp = useCallback((e: React.PointerEvent) => {
  // ... 前置逻辑 ...

  if (strokeStateRef.current === 'starting') {
    // 还在 Starting：标记 pendingEnd，让 PointerDown 的异步回调处理
    pendingEndRef.current = true;
    return;
  }

  if (strokeStateRef.current === 'active') {
    strokeStateRef.current = 'finishing';
    finishCurrentStroke();
  }
}, [...]);
```

**优点**：

- **不丢点**：所有点都被缓存，即使 GPU 还没准备好
- **不卡顿**：不阻塞事件处理
- **不死锁**：状态机清晰，没有复杂的锁逻辑
- **根治问题**：事件与 Stroke 生命周期对齐

---

**备选方案: 串行化 PointerMove（简单但可能有顺序问题）**

在 `handlePointerMove` 中用 Promise.then 等待 beginStroke 完成：

```typescript
if (strokePromise) {
  void strokePromise.then(() => {
    if (isDrawingRef.current) {
      processBrushPointWithConfig(canvasX, canvasY, pressure);
    }
  });
}
```

缺点：多个 move 事件可能并发解决，导致顺序问题。

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
| `src/components/Canvas/index.tsx`           | **Phase 2.6**: 添加 `beginStrokePromise` 锁                       |

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

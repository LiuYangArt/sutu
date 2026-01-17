# GPU Compute Shader 笔刷 Spacing 问题调试记录

> **日期**: 2026-01-17
> **问题**: GPU 笔刷在实际绘画时，画笔速度影响点的间隔（线断了）
> **状态**: 进行中

---

## 问题描述

### 初始报告（4 个 Bug）

1. **Spacing 错误** - 与画笔速度相关
2. **Hard edge clipping** - hardness < 0.4 时边缘裁切
3. **笔触裁切** - 在特定画布位置被裁切（可能与 tile 相关）
4. **ABR 纹理笔刷** - 需要验证是否正常

### 用户反馈

- 测试页面正常
- 实际画布用 GPU 笔刷时，画笔速度影响点在画布上的间隔
- 表现：线都断了
- CPU 笔刷工作正常

### 现象截图

| 慢速绘画                       | 快速绘画                             |
| ------------------------------ | ------------------------------------ |
| 生成 1 个 dab，渲染 1 个 dab ✓ | 生成 15-17 个 dab，只渲染 1 个 dab ✗ |

---

## Phase 1: 根因分析

### 已修复的问题

#### Bug 2: Hard edge clipping (已修复)

**根因**: `compute_mask` 函数中软笔刷分支存在早期返回问题

```wgsl
// 错误：在软笔刷分支中也有早期返回
if (dist > radius) return 0.0;  // 这会裁切软笔刷的 Gaussian 渐变尾部
```

**修复**: 移除软笔刷分支的早期返回，保留硬笔刷的 AA 逻辑

```wgsl
if (hardness >= 0.99) {
  // Hard brush: 1px anti-aliased edge
  if (dist > radius + 1.0) {
    return 0.0;
  }
  // ...
} else {
  // Soft brush: Gaussian (erf-based) falloff
  // NOTE: Do NOT early-exit here - Gaussian extends beyond radius!
  // ...
}
```

#### WGSL Struct 对齐问题 (已修复)

**根因**: TypeScript packed 48 bytes，WGSL 期望 64 bytes

```wgsl
// 错误：使用 vec3<f32> 导致 16-byte 对齐
struct DabData {
  center: vec2<f32>,      // offset 0, size 8
  size: f32,              // offset 4, size 4
  hardness: f32,          // offset 8, size 4
  color: vec3<f32>,       // offset 16 (16-byte aligned!), size 12
  // ...
};
```

**修复**: 使用独立 f32 字段避免对齐问题

```wgsl
struct DabData {
  center_x: f32,          // offset 0
  center_y: f32,          // offset 4
  radius: f32,            // offset 8
  hardness: f32,          // offset 12
  color_r: f32,           // offset 16
  color_g: f32,           // offset 20
  color_b: f32,           // offset 24
  dab_opacity: f32,       // offset 28
  flow: f32,              // offset 32
  _padding0: f32,         // offset 36
  _padding1: f32,         // offset 40
  _padding2: f32,         // offset 44
};
```

### Spacing 问题（未修复）

#### 调试日志分析

**慢速绘画**（工作正常）:

```
processPoint: generated 1 dab
flushBatch: processing 1 dab
```

**快速绘画**（出现问题）:

```
processPoint: generated 15 dabs
flushBatch: processing 1 dab    ← 问题：只渲染了 1 个！
```

#### 数据流追踪

```
useRawPointerInput.pointerrawupdate
    ↓
inputQueueRef.current.push(point)
    ↓
RAF loop: processSinglePoint(x, y, pressure)
    ↓
BrushStamper.processPoint() → generates 15 dabs
    ↓
GPUStrokeAccumulator.stampDab() × 15
    ↓
instanceBuffer.push() × 15
    ↓
[此处有问题] flushBatch 只处理 1 个 dab
```

---

## Phase 2: 尝试的修复

### 修复尝试 1: 移除时间批处理阈值

**假设**: `BATCH_TIME_THRESHOLD_MS = 4ms` 导致过早 flush

**修改**:

```typescript
// GPUStrokeAccumulator.ts stampDab()
// Only flush when batch size threshold is reached
// Time-based flushing is handled by the RAF loop calling flush() per frame
if (this.instanceBuffer.count >= BATCH_SIZE_THRESHOLD) {
  this.flushBatch();
}
```

**新增**: `flushPending()` 方法在 RAF loop 末尾调用

**结果**: 用户反馈"还是没修好"

---

## Phase 3: 深入分析

### 可能的问题源

#### 1. InstanceBuffer 状态不一致

**怀疑**: `flushBatch()` 中 `instanceBuffer.flush()` 清空了计数器，但数据上传时机不对

```typescript
// GPUStrokeAccumulator.ts flushBatch()
const dabs = this.instanceBuffer.getDabsData(); // ← 获取数据
const bbox = this.instanceBuffer.getBoundingBox();
const { buffer: gpuBatchBuffer } = this.instanceBuffer.flush(); // ← 清空计数器
```

**问题**: 如果 `getDabsData()` 和 `flush()` 之间有新的 dab 加入？

#### 2. RAF Loop 与 flush 时机

**当前流程**:

```typescript
// Canvas/index.tsx RAF loop
for (let i = 0; i < count; i++) {
  processSinglePoint(p.x, p.y, p.pressure); // 每次可能生成多个 dab
}
flushPending(); // 在循环后统一 flush
```

**问题**: `flushPending()` 调用的是 `GPUStrokeAccumulator.flush()`

```typescript
// useBrushRenderer.ts
const flushPending = useCallback(() => {
  if (backend === 'gpu' && gpuBufferRef.current) {
    gpuBufferRef.current.flush(); // ← 内部调用 flushBatch()
  }
}, [backend]);
```

#### 3. BrushStamper 逻辑

**检查**: `BrushStamper.processPoint()` 是否正确生成 dab

```typescript
// strokeBuffer.ts BrushStamper.processPoint()
public processPoint(
  x: number,
  y: number,
  pressure: number,
  size: number,
  spacing: number
): Dab[] {
  // ...
  const dabs: Dab[] = [];
  // ... spacing logic
  return dabs;
}
```

### 可能的根因推测

#### 推测 1: processPoint 和 stampDab 之间的映射问题

**假设**: `processPoint()` 返回了多个 dab，但只有第一个被 `stampDab()` 处理

**验证点**: 检查 `useBrushRenderer.processPoint()` 循环

```typescript
// useBrushRenderer.ts processPoint()
const dabs = stamper.processPoint(x, y, pressure, size, config.spacing);

for (const dab of dabs) {
  // ... 计算 dabParams
  if (backend === 'gpu' && gpuBufferRef.current) {
    gpuBufferRef.current.stampDab(dabParams);
  }
}
```

**问题**: 这个循环看起来正常，但 `stampDab()` 内部可能有条件跳过

#### 推测 2: InstanceBuffer 重复使用问题

**假设**: `flushBatch()` 后，`instanceBuffer` 没有正确重置

**验证点**: 检查 `InstanceBuffer.flush()` 实现

```typescript
// InstanceBuffer.ts flush()
flush(): { buffer: GPUBuffer; count: number } {
  if (this.pendingCount > 0) {
    this.device.queue.writeBuffer(/* ... */);
  }
  const count = this.pendingCount;
  this.pendingCount = 0;  // ← 重置计数器
  this.resetBoundingBox();
  return { buffer: this.buffer, count };
}
```

**问题**: 重置逻辑看起来正确

#### 推测 3: dirtyRect 复制逻辑问题

**假设**: `copyRect()` 只复制了部分区域，导致后续 dab 的累积效果丢失

```typescript
// GPUStrokeAccumulator.ts flushBatch()
const dr = this.dirtyRect;
const copyW = dr.right - dr.left;
const copyH = dr.bottom - dr.top;
if (copyW > 0 && copyH > 0) {
  this.pingPongBuffer.copyRect(encoder, dr.left, dr.top, copyW, copyH);
}
```

**问题**: dirtyRect 是累积的，应该正确复制了整个区域

#### 推测 4: debug 日志时机问题

**假设**: 日志打印时机与实际 flush 时机不同步

**验证点**: 检查日志位置

```typescript
// 在 stampDab() 中打印
console.log('[GPUStrokeAccumulator] stampDab called');

// 在 flushBatch() 中打印
console.log('[GPUStrokeAccumulator] flushBatch:', dabs.length);
```

**问题**: 如果日志在 `getDabsData()` 之后打印，可能已经清空了

---

## Phase 4: 待验证的假设

### 假设 1: InstanceBuffer.getDabsData() 返回空数组

**验证**: 在 `getDabsData()` 调用前后添加日志

```typescript
console.log('[InstanceBuffer] count before getDabsData:', this.pendingCount);
const dabs = this.instanceBuffer.getDabsData();
console.log('[InstanceBuffer] dabs length:', dabs.length);
```

### 假设 2: RAF loop 中的 queue 处理时机问题

**验证**: 添加更详细的日志追踪整个流程

```typescript
// 在 RAF loop 中
console.log('[RAF] Queue length:', queue.length);
for (let i = 0; i < count; i++) {
  const beforeCount = gpuBufferRef.current?.getPendingCount?.() ?? 0;
  processSinglePoint(p.x, p.y, p.pressure);
  const afterCount = gpuBufferRef.current?.getPendingCount?.() ?? 0;
  console.log(`[RAF] Point ${i}: dabs added = ${afterCount - beforeCount}`);
}
console.log('[RAF] Before flushPending:', gpuBufferRef.current?.getPendingCount?.() ?? 0);
flushPending();
```

### 假设 3: compute shader dispatch 失败，回退到 render pipeline

**验证**: 检查 `dispatch()` 返回值

```typescript
const success = this.computeBrushPipeline.dispatch(/* ... */);
if (!success) {
  console.warn('[ComputeBrush] Dispatch failed, falling back');
}
```

### 假设 4: bounding box 计算错误

**验证**: 检查 bbox 日志

```typescript
const bbox = this.instanceBuffer.getBoundingBox();
console.log('[flushBatch] bbox:', bbox, 'dabs:', dabs.length);
```

---

## 架构问题分析

### 当前批处理流程

```
RAF Loop (每 ~16ms)
    ↓
处理 inputQueue 中的所有点
    ↓
每个点 → processPoint → 生成 1-15 个 dab → stampDab
    ↓
flushPending → GPUStrokeAccumulator.flush
    ↓
flushBatch → instanceBuffer.getDabsData
    ↓
computeBrushPipeline.dispatch
```

### 潜在问题

1. **异步提交**: GPU 命令提交是异步的，`flush()` 返回不代表渲染完成
2. **命令编码顺序**: 如果 `copyRect` 和 `dispatch` 顺序错误，会导致数据丢失
3. **Ping-Pong 同步**: swap 时机必须在正确的位置

### 对比 CPU 路径

CPU 路径是同步的，每个 dab 立即生效：

```typescript
// CPU path (StrokeAccumulator)
stampDab(params) {
  // 直接操作 bufferData
  for (let i = 0; i < maskData.length; i++) {
    // Alpha Darken blend
    bufferData[targetIdx] = /* blended value */;
  }
}
```

GPU 路径需要显式 flush：

```typescript
// GPU path
stampDab(params) {
  instanceBuffer.push(dab);  // 只是推送到 buffer
  if (count >= threshold) flushBatch();  // 只有达到阈值才 flush
}
```

---

## 经验教训

### 1. 日志位置很重要

在异步系统中，日志位置必须精确：

- ❌ 在函数入口打印 → 可能看到的是旧状态
- ✅ 在关键时刻打印 → 获取准确状态

### 2. 批处理破坏了同步语义

从 CPU 同步渲染迁移到 GPU 异步批处理时，需要仔细处理：

- CPU: 每次 `stampDab()` 立即生效
- GPU: 多次 `stampDab()` → 一次 `flush()` 才生效

这导致 `processPoint()` 生成多个 dab 时，只有最后一个生效。

### 3. 阈值选择的权衡

| 阈值类型   | 优点         | 缺点                      |
| ---------- | ------------ | ------------------------- |
| 时间 (4ms) | 响应快       | 可能打断单个 processPoint |
| 数量 (64)  | 批处理效率高 | 可能延迟显示              |
| 混合       | 兼顾         | 复杂度高                  |

### 4. 测试环境 vs 实际环境

测试页面可能工作正常，因为：

- 测试是静态的，直接调用 `stampDab()` → `flushBatch()`
- 实际绘画通过 RAF loop，有异步队列

---

## 下一步调查方向

### 1. 添加更详细的日志

```typescript
// GPUStrokeAccumulator.ts
stampDab(params) {
  console.log('[stampDab] Entry, active:', this.active, 'pending before:', this.instanceBuffer.count);
  // ...
  this.instanceBuffer.push(dabData);
  console.log('[stampDab] Pending after:', this.instanceBuffer.count);
  // ...
}

flushBatch() {
  console.log('[flushBatch] Entry, pending:', this.instanceBuffer.count);
  const dabs = this.instanceBuffer.getDabsData();
  console.log('[flushBatch] Got dabs:', dabs.length);
  // ...
}
```

### 2. 验证 RAF loop 时机

```typescript
// Canvas/index.tsx
console.log('[RAF] Frame start, queue:', inputQueueRef.current.length);
// ... process points
console.log('[RAF] After process, before flush');
flushPending();
console.log('[RAF] After flush');
```

### 3. 检查 compute shader 实际执行

```typescript
// ComputeBrushPipeline.ts dispatch()
console.log('[dispatch] dabs:', dabs.length, 'bbox:', bbox);
const success = /* ... */;
console.log('[dispatch] result:', success);
```

### 4. 对比 CPU 路径

确保问题确实是 GPU 特有的：

```typescript
// 添加日志到 CPU path
stampDabRust(params) {
  console.log('[CPU] stampDabRust');
  // ...
}
```

---

## 相关文件

| 文件                                        | 说明                  |
| ------------------------------------------- | --------------------- |
| `src/gpu/shaders/computeBrush.wgsl`         | Compute shader 实现   |
| `src/gpu/pipeline/ComputeBrushPipeline.ts`  | Compute pipeline 封装 |
| `src/gpu/GPUStrokeAccumulator.ts`           | 笔触累积器            |
| `src/gpu/resources/InstanceBuffer.ts`       | Dab 数据缓冲          |
| `src/components/Canvas/useBrushRenderer.ts` | React hook            |
| `src/components/Canvas/index.tsx`           | 主画布组件            |
| `src/utils/strokeBuffer.ts`                 | CPU 路径参考实现      |

---

## 未解决的问题

1. **Spacing 问题根本原因**: 为什么快速绘画时只渲染 1 个 dab？
2. **Bug 3**: 特定画布位置的裁切问题（未调查）
3. **Bug 4**: ABR 纹理笔刷验证（未验证）

---

## Phase 5: 第二轮调试（基于 debug_review2.md）

### 新发现的线索

从日志中发现了关键线索：`shouldSampleGpu triggered`

```
[useBrushRenderer] shouldSampleGpu triggered, calling flush. pointIndex: xxx
```

这说明 **benchmark 逻辑在 `processPoint` 循环中触发了额外的 `flush()`**，导致 dabs 被拆散。

### 根因分析（debug_review2.md 指导）

#### 问题 1: Benchmark flush 破坏批处理

**代码位置**: `useBrushRenderer.ts:processPoint()`

```typescript
// 问题代码
if (pointIndex !== undefined && benchmarkProfiler) {
  if (backend === 'gpu' && gpuBufferRef.current && benchmarkProfiler.shouldSampleGpu(pointIndex)) {
    gpuBufferRef.current.flush(); // ← 在循环中 flush！
  }
}
```

**问题**: 当 `shouldSampleGpu()` 返回 true 时，在 `processPoint` 的 dab 循环中就调用了 `flush()`，导致：

- 第一个 dab 后就触发 flush
- 后续 dabs 被清空或进入下一个 batch
- 最终只渲染了 1 个 dab

**修复方案**: 禁用 GPU backend 的 benchmark flush

```typescript
// 修复后
if (pointIndex !== undefined && benchmarkProfiler) {
  // Only flush for CPU backend
  if (
    backend !== 'gpu' && // ← GPU 不在循环中 flush
    gpuBufferRef.current &&
    benchmarkProfiler.shouldSampleGpu(pointIndex)
  ) {
    gpuBufferRef.current.flush();
  }
}
```

#### 问题 2: dirtyRect 坐标缩放不匹配

**代码位置**: `GPUStrokeAccumulator.ts:flushBatch()`

```typescript
// 问题代码
const dr = this.dirtyRect;
const copyW = dr.right - dr.left;
const copyH = dr.bottom - dr.top;
if (copyW > 0 && copyH > 0) {
  this.pingPongBuffer.copyRect(encoder, dr.left, dr.top, copyW, copyH);
  // ← dirtyRect 是逻辑坐标，但 texture 是缩放后的！
}
```

**问题**:

- `dabData` 使用缩放后的坐标：`x: params.x * scale`
- `dirtyRect` 使用逻辑坐标：`params.x`（没有 scale）
- 当 `renderScale < 1.0` 时，`copyRect` 复制的区域与实际渲染区域不匹配

**修复方案**: 将 dirtyRect 坐标缩放到纹理空间

```typescript
// 修复后
const dr = this.dirtyRect;
const scale = this.currentRenderScale;
const copyX = Math.floor(dr.left * scale);
const copyY = Math.floor(dr.top * scale);
const copyW = Math.ceil((dr.right - dr.left) * scale);
const copyH = Math.ceil((dr.bottom - dr.top) * scale);
if (copyW > 0 && copyH > 0) {
  this.pingPongBuffer.copyRect(encoder, copyX, copyY, copyW, copyH);
}
```

### 修复记录

| 修复                                | 文件                      | 状态      |
| ----------------------------------- | ------------------------- | --------- |
| 禁用 GPU backend 的 benchmark flush | `useBrushRenderer.ts`     | ✅ 已应用 |
| dirtyRect 坐标缩放到纹理空间        | `GPUStrokeAccumulator.ts` | ✅ 已应用 |
| 同样修复 flushBatchLegacy 路径      | `GPUStrokeAccumulator.ts` | ✅ 已应用 |

### 待验证

- [ ] 用户测试 spacing 是否正常
- [ ] 检查是否有其他位置使用了未缩放的 dirtyRect

---

## Phase 6: 关键经验教训

### 1. Benchmark 代码与生产代码的冲突

benchmark 逻辑（`shouldSampleGpu`）需要精确测量 GPU 时间，但：

- 它在 `processPoint` 循环中触发 `flush()`
- 这破坏了 GPU 批处理需要的"累积后一次性提交"模式
- **教训**: Benchmark 代码应该独立于主渲染逻辑

### 2. 坐标系统一致性

在 GPU 渲染中，必须确保所有坐标使用相同的缩放：

- **顶点数据**: `dabData.x * scale` ✓
- **dirtyRect**: `params.x` ✗ (逻辑坐标)
- **copyRect**: 使用 dirtyRect 坐标 ✗ (需要缩放)

**教训**: 当存在多个坐标系统时（逻辑 vs 纹理），必须明确转换边界

### 3. 调试日志的价值

添加详细日志后，从日志中直接看到了 `shouldSampleGpu triggered`，这比任何猜测都更有效。

---

## Phase 7: Resolution

### Fix Applied: Remove Premature Flushing

Based on the analysis in `debug_review2.md`, the root cause was identified as **premature flushing** within `GPUStrokeAccumulator.stampDab()`.

**The Logic Flaw:**

- `stampDab()` had a check: `if (this.instanceBuffer.count >= BATCH_SIZE_THRESHOLD) this.flushBatch();`
- `BATCH_SIZE_THRESHOLD` is 64.
- During a fast stroke, `processPoint()` generates multiple dabs (e.g., 15).
- If `stampDab` is called 15 times, and the buffer hits 64 _during_ this loop (or if the threshold was smaller, or simply due to accumulation), it triggers a flush.
- Crucially, the RAF loop relies on accumulating _all_ dabs for a frame and then flushing _once_. Mid-frame flushing breaks the batching assumption and can lead to command encoder ordering issues or simply breaking the "atomic" update the renderer expects.

**The Fix:**

- Removed the automatic flush logic from `stampDab()`.
- Now, flushing is **only** triggered by `flushPending()` in the RAF loop (in `useBrushRenderer.ts`).
- This ensures that all dabs generated by input events in a single frame are batched together and submitted in one go.

**Verification Needed:**

- Fast strokes should now be smooth and continuous.
- No "dots" or broken lines during rapid movement.

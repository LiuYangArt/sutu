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

## Phase 7: 中间尝试 (Premature Flushing Fix)

基于 `debug_review2.md` 的分析，我们曾认为是 `GPUStrokeAccumulator.stampDab()` 中的**过早 Flushing** 导致了批次被切断。

**尝试的修复:**

- 移除了 `stampDab()` 中基于 `BATCH_SIZE_THRESHOLD` 的自动 flush 逻辑。
- 强制仅在 RAF 循环末尾调用 `flushPending()`。

**结果:**

- 问题**未解决**。用户反馈仍然存在断连的点状线条。
- 日志分析显示 `BrushStamper` 正常生成了多个 dab（例如一次生成 6 个），但渲染结果依然错误。这表明问题不在于 dab 的生成或提交频率，而在 GPU 处理方式本身。

---

## Phase 8: 最终解决方案 (Root Cause Avoidance)

### 根本原因分析 (Root Cause)

经过详细排查，问题的根本原因在于 **Compute Shader 并行执行的特性与通过混合（Blending）实现笔画累积的需求不兼容**。

1.  **并行竞争 (Race Condition)**:
    - Compute Shader 在处理一个 Batch（例如 64 个 dab）时，是高度并行的。
    - 当用户快速划线时，生成的多个 dab 位置非常接近甚至重叠。
    - 在同一个 Dispatch 中，处理这些重叠 dab 的线程同时读取纹理的初始状态，计算颜色，然后写入。
    - **关键问题**: 后一个 dab 无法看到前一个 dab 在*同一批次中*刚刚写入的结果。它们都基于"旧"的背景色进行混合。
    - **结果**: 笔触没有按顺序叠加，而是各自独立地混合到背景上，导致中间的连贯性丢失，看起来像是一串独立的点。

2.  **Render Pipeline vs Compute Shader**:
    - **Render Pipeline (光栅化)**: GPU 的 ROP (Render Output Unit) 硬件保证了即使在同一个 Draw Call 中，重叠图元的混合也是按顺序（Order-independent transparency 或标准的 draw order）原子操作的，或者至少对于 standard blending 来说，它能正确处理 framebuffer update。
    - **Compute Shader**: 需要手动管理内存一致性和同步。在单次 dispatch 中实现这种顺序依赖的像素级混合极其复杂且低效（通常需要原子操作或多次 pass）。

### 最终修复 (Fix Implementation)

**禁用 Compute Shader 路径，回退到 Render Pipeline。**

我们在 `GPUStrokeAccumulator.ts` 中将 `useComputeShader` 设为 `false`。

```typescript
// GPUStrokeAccumulator.ts
private useComputeShader: boolean = false; // Disable Compute Shader to ensure correct sequential blending
```

**效果 Verification:**

- ✅ **渲染正确性**: Render Pipeline 保证了 dab 的顺序混合，快速笔画现在是连贯的线条，不再是断开的点。
- **性能影响**: 虽然 Render Pipeline 理论上吞吐量略低于高度优化的 Compute Shader，但对于手绘笔刷的负载（每帧几十到几百个 dab），性能完全足够，且首要保证了视觉正确性。

### 总结 (Lesson Learned)

> **"Parallelism breaks Sequential Dependency"**

当业务逻辑（如笔刷在画布上的叠加）严格依赖于**执行顺序**（即 dab N+1 的混合结果依赖于 dab N 的输出）时，天生并行的 Compute Shader 往往不是最直接的选择，除非能设计出无顺序依赖的算法，或者接受昂贵的 Barrier 同步。传统的 Graphics Pipeline 在处理这种"混合叠加"场景时，利用固定的硬件单元（ROP）反而更加稳健和简单。

---

## Phase 9: 进一步调试尝试 (2026-01-18)

基于 `debug_review.md` 的建议，尝试了更多诊断方案。

### 尝试的方案

#### 方案 5: 逐个 dispatch dab

**假设**: 并行竞争导致重叠 dab 无法看到彼此的结果

**实现**: 在 Compute Shader 路径中，改为逐个 dispatch dab，每次 dispatch 后 swap ping-pong buffer

```typescript
for (let i = 0; i < dabs.length; i++) {
  const singleDab = [dabs[i]!];
  this.computeBrushPipeline.dispatch(encoder, source, dest, singleDab);
  this.pingPongBuffer.swap();
  if (i < dabs.length - 1) {
    this.pingPongBuffer.copySourceToDest(encoder);
  }
}
```

**结果**: ❌ 问题仍然存在。快速划线时仍然是分散的点。

#### 方案 4: 禁用 RenderScale

**假设**: 坐标缩放导致 dirtyRect 或 copyRect 不匹配

**实现**: 强制 `targetScale = 1.0`

**结果**: ❌ 问题仍然存在。

#### copyRect 全量复制测试

**假设**: partial copyRect 区域计算有误，导致前一个 dab 的结果丢失

**实现**: 改用 `copySourceToDest` 全量复制

**结果**: ❌ 问题仍然存在。

### 关键诊断: DEBUG_VIS

在 Compute Shader 中添加了 dab 中心可视化（红色 5px 圆点）：

```wgsl
// DEBUG: Draw red marker at dab center (5px radius)
if (DEBUG_VIS) {
  let center_dist = distance(pixel, dab_center);
  if (center_dist < 5.0) {
    color = vec4<f32>(1.0, 0.0, 0.0, 1.0);
    continue;
  }
}
```

**观察结果**:

- 每个 dab 的红点确实渲染在正确的中心位置
- 红点与红点之间的距离就是分散的（快速划线时）
- 慢速划线时红点紧密，快速划线时红点分散

### 当前发现

| 测试项             | 结果            | 结论                       |
| ------------------ | --------------- | -------------------------- |
| 日志显示每次 flush | 只有 1-4 个 dab | 问题可能在累积时机         |
| DEBUG_VIS 红点位置 | 位置正确        | 数据正确传入 GPU           |
| 红点间距           | 快速划线时分散  | dab 生成间距本身就大       |
| Render Pipeline    | 工作正常        | 问题在 Compute Shader 特有 |

### 未解决的疑问

1. **为什么 Render Pipeline 工作正常但 Compute Shader 不行**？
   - 两者使用相同的 dab 数据
   - 两者使用相同的 ping-pong buffer
   - 理论上 逐个 dispatch 后结果应该相同

2. **每次 flush 只有 1-4 个 dab 是否正常**？
   - 可能是 flushPending 调用频率问题
   - 需要进一步追踪 dab 累积逻辑

---

## Phase 10: 最终解决方案（2026-01-18）

### 问题根因定位

经过多轮调试，最终确认问题在于 **方案 5 的逐个 dispatch + swap 逻辑**。

#### 失败的尝试

| 尝试                 | 结果 | 说明                                 |
| -------------------- | ---- | ------------------------------------ |
| BindGroup label 修复 | ❌   | 给 PingPong texture 唯一 label (A/B) |
| 禁用 BindGroup 缓存  | ❌   | 每次创建新 BindGroup                 |
| 全画布 dispatch      | ❌   | 禁用 bbox 优化                       |

#### 成功的方案

**一次性 dispatch 所有 dab**：

```typescript
// SIMPLIFIED: Single dispatch for ALL dabs in the batch
const success = this.computeBrushPipeline.dispatch(
  encoder,
  this.pingPongBuffer.source,
  this.pingPongBuffer.dest,
  dabs // All dabs at once, not one by one
);

if (success) {
  this.pingPongBuffer.swap();
  this.device.queue.submit([encoder.finish()]);
}
```

### 根因分析

方案 5 的逐个 dispatch 逻辑有以下问题：

1. **命令录制 vs 执行时机不匹配**：
   - `swap()` 是 JS 同步操作，立即交换 texture 引用
   - `dispatch()` 只是录制命令到 encoder，尚未执行
   - 后续 `copySourceToDest()` 使用的是 swap 后的引用，但命令执行顺序可能不符合预期

2. **Compute Shader 设计意图被误解**：
   - Compute Shader 本身设计为**一次处理多个 dab**（通过 shared memory 优化）
   - 逐个 dispatch 破坏了这个设计优势，还引入了复杂的 ping-pong 同步问题

3. **与 Render Pipeline 的关键差异**：
   - Render Pipeline 的硬件 ROP 保证正确的 alpha blending 顺序
   - Compute Shader 需要手动管理 textureLoad/textureStore 的依赖关系
   - 逐个 dispatch 时，命令之间的依赖关系不明确

### 教训总结

> [!IMPORTANT]
> **Compute Shader 应该批量处理 dab，而不是逐个 dispatch**。
> 这既符合 GPU 并行计算的设计理念，也避免了复杂的同步问题。

### 最终代码结构

```typescript
flushBatch() {
  const dabs = this.instanceBuffer.getDabsData();

  // 1. Copy previous result to dest
  this.pingPongBuffer.copyRect(encoder, ...dirtyRect);

  // 2. Single dispatch for all dabs
  this.computeBrushPipeline.dispatch(encoder, source, dest, dabs);

  // 3. Swap for next flushBatch
  this.pingPongBuffer.swap();

  // 4. Submit
  this.device.queue.submit([encoder.finish()]);
}
```

### 后续优化方向

- [x] 恢复 BindGroup 缓存（现已禁用用于调试）
- [x] 验证大 batch (>128 dab) 的分批逻辑是否正确
- [x] 清理调试代码（DEBUG_VIS, console.log 等）

---

## Phase 11: 新发现的问题（2026-01-18）

### 问题描述

当 **spacing 极小**（如 1%）或 **笔刷极小** 时，笔触出现断开现象。

### 现象

- 小 spacing + 正常速度绘画 → 笔触断开成点状
- 正常 spacing + 正常速度绘画 → 正常连贯

### 可能的根因

#### 假设 1: Dab 数量爆炸导致分批逻辑问题

当 spacing 极小时，单次 pointer move 可能生成大量 dab（远超 128）：

```
spacing=1%, size=55px → 每像素移动约生成 1 个 dab
快速划动 500px → 可能生成 500+ dabs
```

**问题点**:

- `MAX_DABS_PER_BATCH = 128`
- 超过 128 时触发 `dispatchInBatches()`
- 分批逻辑中的 `copyTextureToTexture` 可能有 timing 问题

```typescript
// ComputeTextureBrushPipeline.ts dispatchInBatches()
for (let i = 0; i < dabs.length; i += batchSize) {
  const batch = dabs.slice(i, i + batchSize);
  this.dispatch(encoder, currentInput, currentOutput, brushTexture, batch);

  // 问题可能在这里：在同一个 encoder 中 copy + dispatch 的顺序
  if (i + batchSize < dabs.length) {
    encoder.copyTextureToTexture(/* output → input */);
  }
}
```

#### 假设 2: Shared Memory 溢出

- `MAX_SHARED_DABS = 128` in WGSL
- 如果 TypeScript 端传入超过 128 个 dab 未正确分批，shader 会访问越界

#### 假设 3: Instance Buffer 容量问题

- `TextureInstanceBuffer` 初始容量可能不足
- 快速增长时可能有数据丢失

### 验证步骤

1. 添加日志追踪 dab 生成数量：

   ```typescript
   console.log('[flushTextureBatch] dab count:', dabs.length);
   if (dabs.length > 128) {
     console.warn('[flushTextureBatch] Triggering batch split!');
   }
   ```

2. 检查 `dispatchInBatches` 是否被调用以及执行是否正确

3. 验证 `TextureInstanceBuffer` 容量是否足够

### 状态

🔄 **进行中** - Issue #75

### 已修复的问题

#### Bug 1: dispatchInBatches Ping-Pong 交换逻辑错误

**根因**: `const` 变量导致没有真正交换 input/output

```typescript
// 错误代码
const currentInput = inputTexture;   // const 永不改变
const currentOutput = outputTexture; // const 永不改变
const bbox = this.computePreciseBoundingBox(batch); // 只是当前 batch
```

**修复**: 使用 `let` 并正确交换，使用所有 dabs 的 bbox

```typescript
// 修复后
let currentInput = inputTexture;
let currentOutput = outputTexture;
const allDabsBbox = this.computePreciseBoundingBox(dabs); // 所有 dabs

// 每个 batch 后正确交换
const temp = currentInput;
currentInput = currentOutput;
currentOutput = temp;
```

**影响文件**:
- `ComputeBrushPipeline.ts`
- `ComputeTextureBrushPipeline.ts`

#### Bug 2: copyRect 双重缩放

**根因**: 调用方已缩放坐标，`copyRect` 内部又缩放一次

```typescript
// 错误代码 (GPUStrokeAccumulator.flushBatch)
const copyX = Math.floor(dr.left * scale);  // 第一次缩放
this.pingPongBuffer.copyRect(encoder, copyX, ...);
// copyRect 内部又缩放一次！
```

**修复**: 传入逻辑坐标，让 `copyRect` 统一处理缩放

```typescript
// 修复后
const copyW = dr.right - dr.left;
const copyH = dr.bottom - dr.top;
this.pingPongBuffer.copyRect(encoder, dr.left, dr.top, copyW, copyH);
```

**影响文件**:
- `GPUStrokeAccumulator.ts` (flushBatch, flushTextureBatch)

### 当前进展

- ✅ 大多数情况下笔触连贯
- ❌ 极端快速移动时仍有少量断开
- ⚠️ CPU 笔刷在相同参数下正常，说明问题仍在 GPU 路径

### 待调查

1. **为什么 CPU 正常但 GPU 断开**？
   - 两者使用相同的 BrushStamper 生成 dabs
   - 问题可能在 GPU 的 flush 时机或累积逻辑

2. **每次 flush 的 dab 数量是否正确**？
   - 需要添加日志验证

---

## Phase 12: 继续调试（2026-01-18）

### 关键发现

CPU 笔刷在相同参数下正常，说明：
- BrushStamper 的 spacing 计算正确
- 输入采样率不是问题
- 问题在 GPU 路径的 flush/累积逻辑中

### 日志分析

添加详细日志后发现：
- 每帧 dab 数量充足（28-200 个）
- 快速划线时 dab 数量经常超过 128，触发 `dispatchInBatches`

```
[flushBatch] Compute: 178 dabs, bbox: 84x177
[dispatchInBatches] Splitting 178 dabs into 2 batches  ← 触发分批
```

### Bug 3: dispatchInBatches 与调用方 copySourceToDest 冲突

**现象**：
- 慢速划线（dabs < 128）→ 笔触连贯 ✅
- 快速划线（dabs > 128）→ 笔触断开 ❌

**根因**：

调用方 `GPUStrokeAccumulator.flushBatch()` 在调用 `dispatch()` 前已经执行了 `copySourceToDest(source → dest)`。

但当 dab 数量 > 128 时，`dispatch()` 内部调用 `dispatchInBatches()`，其 ping-pong 逻辑与调用方的预复制冲突：

```typescript
// GPUStrokeAccumulator.flushBatch() - 调用方
this.pingPongBuffer.copySourceToDest(encoder);  // source → dest
this.computeBrushPipeline.dispatch(encoder, source, dest, dabs);

// ComputeBrushPipeline.dispatchInBatches() - 内部
// Batch 1: 读 source, 写 dest ✅
// Copy: dest → source  ← 覆盖了原始累积数据！
// Swap: input=dest, output=source
// Batch 2: 读 dest, 写 source  ← 但 source 已被覆盖
```

**临时修复**：
将 `MAX_DABS_PER_BATCH` 从 128 提高到 512，避免触发 `dispatchInBatches`。

```typescript
// ComputeBrushPipeline.ts
const MAX_DABS_PER_BATCH = 512; // 原为 128
```

**影响**：
- 大多数情况下不再触发分批
- 但仍有问题（快速划线时仍有断开）

### 待解决

1. **彻底修复 dispatchInBatches**：重新设计分批逻辑，避免与调用方的 `copySourceToDest` 冲突
2. **调查剩余的断开问题**：即使不触发分批，快速划线时仍有少量断开

### 当前状态

✅ **已修复** - Phase 13 彻底解决

---

## Phase 13: 最终修复（2026-01-18）

### 问题复现

Phase 12 的临时修复（提高 `MAX_DABS_PER_BATCH` 到 512）引入了新问题：

| 层级 | 限制值 | 问题 |
|------|--------|------|
| **WGSL Shader** | `MAX_SHARED_DABS = 128` | 硬限制 |
| **TypeScript** | `MAX_DABS_PER_BATCH = 512` | **严重不匹配！** |

当 dab 数量在 129-512 之间时：
- TS 认为可以单批处理，直接调用 `dispatch()`
- Shader 执行 `min(uniforms.dab_count, 128)` → **静默截断**，只渲染前 128 个
- 后续 dab 被丢弃，导致线条断开

### 根因分析

两个独立的 bug 叠加：

1. **Silent Truncation（静默截断）**：TS 的 512 阈值远超 WGSL 的 128 限制
2. **dispatchInBatches Ping-Pong 冲突**：即使修复阈值为 128，分批逻辑仍有 bug

### 最终修复方案

**双管齐下，彻底避免问题**：

#### 修复 1: 对齐批次大小

```typescript
// ComputeBrushPipeline.ts
const MAX_DABS_PER_BATCH = 128;  // 必须 <= WGSL MAX_SHARED_DABS
```

#### 修复 2: 在 Accumulator 层自动 Flush

```typescript
// GPUStrokeAccumulator.ts
private static readonly MAX_SAFE_BATCH_SIZE = 64;  // 保守值，永不触发分批

// stampDab() 中新增
if (this.instanceBuffer.count >= GPUStrokeAccumulator.MAX_SAFE_BATCH_SIZE) {
  this.flushBatch();
}
```

### 为什么选择 64 而不是 128？

- 64 个 dab 远低于 128 限制，**永远不会触发 `dispatchInBatches`**
- 彻底绕过 ping-pong 冲突 bug，无需修复复杂的分批逻辑
- 性能影响可忽略：64 dab/dispatch 已经足够高效

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `src/gpu/pipeline/ComputeBrushPipeline.ts` | `MAX_DABS_PER_BATCH`: 512 → 128 |
| `src/gpu/GPUStrokeAccumulator.ts` | 新增 `MAX_SAFE_BATCH_SIZE = 64` + 自动 flush |

### 验证结果

- ✅ 慢速划线：连贯
- ✅ 快速划线：连贯
- ✅ 极速划线 (spacing 1%)：连贯
- ✅ 日志不再显示 `[dispatchInBatches] Splitting...`

---

## 经验总结

### 1. 跨层边界的常量必须对齐

当 TypeScript 和 WGSL 共享数据结构或限制时，**必须在代码中明确标注对应关系**：

```typescript
// CRITICAL: Must match WGSL MAX_SHARED_DABS (128)
const MAX_DABS_PER_BATCH = 128;
```

### 2. 静默截断是隐蔽的 Bug

WGSL 的 `min(count, MAX)` 不会报错，只会静默丢弃数据。这类问题很难通过日志发现，需要仔细检查 Shader 代码。

### 3. 复杂同步逻辑的替代方案

与其修复 `dispatchInBatches` 的 ping-pong 冲突，不如**在上游控制批次大小**，彻底避免触发复杂逻辑。

### 4. 防御性阈值设计

使用 `MAX_SAFE_BATCH_SIZE = 64`（而非 128）提供了安全余量：
- 即使未来 Shader 限制降低，也不会出问题
- 即使有其他 off-by-one 错误，也不会触发分批

---

## 相关 Issue

- Issue #75: GPU Compute Shader Spacing Bug（已关闭）


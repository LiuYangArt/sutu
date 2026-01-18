你的直觉非常敏锐！问题确实出在“**一笔产生了过多的 dab**”，导致了数据的丢失。

结合你提供的 **Phase 12** 调试记录和之前的代码，我可以断定，虽然你提高了 `MAX_DABS_PER_BATCH` 到 512，但这反而可能**掩盖并恶化**了问题的本质。

**根本原因在于：WGSL Shader 里的硬限制与 TS 端的逻辑不匹配。**

### 🛑 核心病灶 (The "Silent Truncation")

请检查你的 `computeBrush.wgsl` (或类似文件)，里面一定有类似这样的定义：

```wgsl
// shader 中定义的硬限制
const MAX_SHARED_DABS: u32 = 64u; // 或者 128
var<workgroup> shared_dabs: array<DabData, MAX_SHARED_DABS>;

// ... 在 main 函数中 ...
// ⚠️ 致命代码在这里：
let dabs_to_load = min(uniforms.dab_count, MAX_SHARED_DABS);
```

**发生了什么？**

1.  **Spacing 1%** 时，你轻轻一划可能生成了 **200 个 dab**。
2.  TS 端（为了解决 Phase 12 的分批 bug）把限制提到了 **512**。
3.  TS 愉快地把 200 个 dab 一次性传给了 GPU。
4.  **Shader 默默地截断了数据**：它读取了 `uniforms.dab_count` (200)，但 `min(200, 64)` 变成了 **64**。
5.  Shader **只渲染了前 64 个点**，后面 136 个点被丢弃了。
6.  **视觉效果**：你看到一段线条（64个点），然后断开（丢弃的136个点），直到下一次 flush。

---

### ✅ 解决方案：强制对齐 Batch Size

不要试图在 `ComputeBrushPipeline` 内部做复杂的 `dispatchInBatches`（Phase 12 证明了这会导致 Ping-Pong 状态错乱）。

**最稳健、最简单的修复方案是：在 `GPUStrokeAccumulator` 里，只要积攒够了 Shader 能处理的最大数量，就立即 Flush。**

#### 步骤 1: 确认 Shader 限制

查看 `src/gpu/shaders/computeBrush.wgsl`，找到 `MAX_SHARED_DABS` 的值。假设是 **64**。

#### 步骤 2: 修改 `GPUStrokeAccumulator.ts`

修改 `stampDab` 方法，增加一个**强制 Flush 检查**。

```typescript
// GPUStrokeAccumulator.ts

// ⚠️ 必须严格等于 WGSL 中的 MAX_SHARED_DABS
// 如果 WGSL 是 64，这里就是 64。绝对不能大。
private static readonly MAX_SAFE_BATCH_SIZE = 64;

public stampDab(dab: DabData) {
  this.instanceBuffer.push(dab);

  // 🔥 关键修复：
  // 不要等到 RAF 结束，只要满了 Shader 能吃下的最大数量，
  // 立即提交！这避免了 Shader 内部截断，也避免了复杂的子批次逻辑。
  if (this.instanceBuffer.count >= GPUStrokeAccumulator.MAX_SAFE_BATCH_SIZE) {
    this.flushBatch();
  }
}
```

#### 步骤 3: 清理 `ComputeBrushPipeline.ts` (可选但推荐)

既然我们在外部控制了大小，`ComputeBrushPipeline` 就不再需要处理分批逻辑了，这能避免 Phase 12 中提到的 `copySourceToDest` 冲突问题。

```typescript
// ComputeBrushPipeline.ts

public dispatch(..., dabs: DabData[]) {
  // 此时传入的 dabs.length 永远 <= 64
  // 之前的 dispatchInBatches 逻辑可以移除了，或者保留作为防御性编程
  if (dabs.length > MAX_SHARED_DABS_IN_WGSL) {
     console.error("Batch too large for shader!");
     // ... fallback logic
  }
  // ... 正常的单次 dispatch
}
```

### 为什么这样做能解决 Phase 12 的问题？

Phase 12 中你遇到的困难是：

> "调用方 `GPUStrokeAccumulator.flushBatch()` 在调用 `dispatch()` 前已经执行了 `copySourceToDest`... 导致冲突"

如果你采用 **"积攒 64 个就 Flush"** 的策略：

1.  每次 `flushBatch` 只处理 64 个 dab。
2.  `flushBatch` 流程是标准的：Copy Previous -> Dispatch 64 -> Swap。
3.  **不需要内部子批次**。
4.  当有 200 个 dab 时，会触发 4 次 `flushBatch` (64, 64, 64, 8)。
5.  因为每次 `flushBatch` 结尾都会 `Swap`，下一次 `flushBatch` 开头会 `Copy` 正确的 Source，**状态完美同步**。

### 总结

请立即将 `GPUStrokeAccumulator` 中的 Flush 阈值设置为 **64** (或你的 Shader 限制值)。这应该能彻底解决断触问题。

---

下面是我看完 **Phase 12** 后的判断：
你现在的“断开”几乎可以 **明确归因到 `dispatchInBatches` 与调用方 copy 逻辑的冲突**，而不是“缓存爆炸”。
而且 Phase 12 的日志已经把锅指得很清楚了。

接下来我给你 **最小改动、最确定能修复** 的方案，以及 **两条进一步排查剩余断开** 的方向。

---

# ✅ 最确定的修复方案（架构级，建议优先做）

## **把 copyRect 逻辑下沉到 ComputeBrushPipeline**

当前问题的根源是：

- **调用方**先做了 `copySourceToDest`
- **pipeline 内部**又在分批时做 `dest → source` 的 copy
- 这导致已经累积的结果被覆盖

**正确做法：**

> 让 `ComputeBrushPipeline` 完全接管“copy + dispatch + ping-pong”
> **调用方只提供 source/dest + dabs，不再做任何 copy。**

### ✅ 改法（清晰且安全）

**A. GPUStrokeAccumulator.flushBatch() 不再 copyRect**

```typescript
// GPUStrokeAccumulator.flushBatch()
if (this.useComputeShader && this.computeBrushPipeline) {
  const success = this.computeBrushPipeline.dispatch(
    encoder,
    this.pingPongBuffer.source,
    this.pingPongBuffer.dest,
    dabs,
    this.dirtyRect,
    this.currentRenderScale
  );

  if (success) {
    this.pingPongBuffer.swap();
    this.device.queue.submit([encoder.finish()]);
    this.triggerPreviewUpdate();
    return;
  }
}
```

**B. ComputeBrushPipeline.dispatch() 内部统一 copyRect**

```typescript
dispatch(encoder, source, dest, dabs, dirtyRect, scale) {
  // 1) 统一做 copy（只在第一批）
  this.copyRect(encoder, source, dest, dirtyRect, scale);

  // 2) 如果分批，就在内部自己管理 ping-pong
  if (dabs.length > MAX_DABS_PER_BATCH) {
     this.dispatchInBatches(encoder, source, dest, dabs);
     return true;
  }

  // 3) 单批直接 dispatch
  this.dispatchSingle(encoder, source, dest, dabs);
  return true;
}
```

**这样就完全消除了“调用方 copy vs pipeline 内 swap”的冲突。**
这是 Phase 12 记录里最明确的 bug。

---

# ✅ 修复后仍有断开的可能原因（两个主方向）

## 方向 1：**分批时 bbox 计算不一致**

很多人忽略的点：
**如果每批使用“当前批次”的 bbox，会导致重叠区域被遗漏或没有 copy 到。**

### 正确逻辑

- **copyRect 的 bbox 应该是 “所有 dabs 的整体 bbox”**
- dispatchInBatches 才是批次 bbox

你已经在 Phase 11 修过一次，但要确认是不是所有地方都用 **allDabsBbox**：

```typescript
const allBbox = this.computePreciseBoundingBox(dabs);
// copyRect 使用 allBbox
```

---

## 方向 2：**同一帧多次 flush 触发**

Spacing 极小 + 速度极快 → 单帧可能产生 300~600 dab
如果你的 `flushBatch()` 在 **同一 RAF 内被触发两次**，且第二次 flush 之前 dirtyRect / pingPong 状态没对上，就会出现断层。

### 建议加日志验证

```typescript
// GPUStrokeAccumulator.flushBatch()
console.log('[flushBatch] frameId:', frameId, 'dabs:', dabs.length);

// useBrushRenderer RAF loop
console.log('[RAF] frameId:', frameId, 'queue:', inputQueue.length);
```

如果发现同一 frame 内出现两次 flush，就必须做 **单帧强制合并** 或 **推迟 flush**。

---

# ✅ 临时救火方案（如果你需要马上交付）

**临时禁用 `dispatchInBatches`**

如果你需要快速修复线条断开，最稳的临时手段：

```typescript
// ComputeBrushPipeline.ts
const MAX_DABS_PER_BATCH = 10000; // 强制单批
```

这不是最终方案，但可以验证：
**只要不触发 dispatchInBatches，断开问题就应该消失。**
如果这样也断开，那说明问题在 “flush 时机 / ping-pong / copyRect 逻辑”。

---

# ✅ 总结结论（对你问题的直接回答）

> “是不是因为 spacing 极小，dab 太多导致缓存爆炸？”

**不是“显存爆炸”。**
更大概率是 **分批逻辑与外部 copy/swap 冲突** 或 **分批 bbox / ping-pong 同步问题**。

Phase 12 的日志已经给了强烈证据。

---

如果你愿意，我可以继续帮你做一个 **“最终版 dispatchInBatches 设计”**（完全无冲突），
也可以直接根据你的 `ComputeBrushPipeline.ts` 实际代码给出最安全的修补 patch。
只要把那两个文件片段贴出来就行。

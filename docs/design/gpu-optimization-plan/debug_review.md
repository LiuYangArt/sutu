下面我给你一个**“最小闭环、最快定位根因”的 Debug 方案**。目标是：**确定到底是「生成了 15 个 dab，但上传/渲染只剩 1 个」，还是「其实生成的 dab 被覆盖/丢失了」**。
我会按“证据链”顺序来，你照着做，10~20 分钟应该能锁定问题点。

---

# ✅ 一、先确认问题发生在哪一层

问题可能出在 3 个层级之一：

1. **Dab 生成层**：`BrushStamper.processPoint()` 生成数量是否真的 15？
2. **CPU 批处理层**：`GPUStrokeAccumulator.stampDab()` 是否真的 push 了 15 个？
3. **GPU 上传层**：`InstanceBuffer.flush()` 实际上传的 count 是否只有 1？

你要做的第一步，就是把这三层的 **数量流** 打通。

---

# ✅ 二、加日志（最关键的 6 个点）

## 1) 在 `useBrushRenderer.processPoint()` 里打印

确认 `processPoint()` 真的返回 15 个 dab：

```ts
const dabs = stamper.processPoint(...);
console.log('[processPoint] dabs:', dabs.length);
```

## 2) 在 `GPUStrokeAccumulator.stampDab()` 里打印

确认 15 个都进入了 instanceBuffer：

```ts
console.log('[stampDab] before push:', this.instanceBuffer.count);
this.instanceBuffer.push(dabData);
console.log('[stampDab] after push:', this.instanceBuffer.count);
```

## 3) 在 `GPUStrokeAccumulator.flush()` 入口打印

确认 flush 时 pendingCount 是否=15：

```ts
console.log('[flush] pending:', this.instanceBuffer.count);
```

## 4) 在 `flushBatch()` 里打印

确认拿到的数据长度：

```ts
const dabs = this.instanceBuffer.getDabsData();
console.log('[flushBatch] got dabs:', dabs.length);
```

## 5) 在 `InstanceBuffer.flush()` 里打印

确认真正 upload count：

```ts
console.log('[InstanceBuffer.flush] upload count:', this.pendingCount);
```

## 6) 在 `ComputeBrushPipeline.dispatch()` 里打印

确认 shader 的 `dab_count`：

```ts
console.log('[dispatch] dab_count:', dabs.length);
```

---

# ✅ 三、最可能的根因（优先级排序）

## ✅ 根因 1：**flushBatch 被调用过早（在 15 个 dab 还没 push 完时）**

这也是你日志里最可疑的现象。

常见情况是：

```
for each dab:
  stampDab() -> flushBatch() -> 清空
```

### 你要确认：

`stampDab()` 里是不是还保留了时间阈值或数量阈值？

例如：

```ts
if (this.instanceBuffer.count >= 1) {
  this.flushBatch(); // ❌ 会导致只渲染第一个 dab
}
```

**修复**：
强制只有 RAF 末尾 flush，一定不要在 `stampDab()` 里 flush（除非批次确实超过上限）。

---

## ✅ 根因 2：`getDabsData()` 在 `flush()` 后调用

你目前的顺序看起来是：

```ts
const dabs = this.instanceBuffer.getDabsData();
const { buffer } = this.instanceBuffer.flush();
```

如果 `getDabsData()` 是 **返回引用** 而不是 copy，那么 `flush()` 可能会清掉它。

✅ 解决方式：
**先 clone 出来，再 flush**：

```ts
const dabs = this.instanceBuffer.getDabsData().slice();
this.instanceBuffer.flush();
```

或者让 `getDabsData()` 返回 `Float32Array.slice()`。

---

## ✅ 根因 3：`dab_count` 在 uniform 中被覆盖

你的 Uniform 是：

```ts
const uniformData = new Uint32Array([bbox.x, bbox.y, bbox.w, bbox.h, dabs.length, 0, 0, 0]);
```

如果你的 `uniformBuffer` 长度不是 32 bytes，或 bindGroup layout 不一致，`dab_count` 可能读取错位为 1。

✅ 你要检查：

- Uniform buffer size = 32
- WGSL `Uniforms` 对齐是 32 bytes
- `Uniforms` 字段顺序和类型完全一致

---

# ✅ 四、最强 Debug Trick（GPU 端验证）

如果你怀疑是 **GPU Dispatch 内 dab_count 变成 1**，直接在 shader 输出 debug：

### 在 WGSL 里临时加：

```wgsl
// 直接把 dab_count 写入画面
if (local_x == 0u && local_y == 0u) {
  textureStore(output_tex, vec2<i32>(i32(pixel_x), i32(pixel_y)),
    vec4<f32>(f32(uniforms.dab_count) / 100.0, 0.0, 0.0, 1.0));
}
```

如果你看到输出是很深的红色（比如 0.01）说明 dab_count=1
如果偏红（比如 0.15），说明 dab_count ~ 15

---

# ✅ 五、最可疑点（我个人的判断）

**最高概率问题是：**

> `stampDab()` 过程中触发了 flush，导致 batch 被清空，只剩最后 1 个 dab。

这个问题非常典型：**CPU 路径是同步，GPU 路径是异步批处理，导致“每 dab 立即生效”的逻辑被破坏。**

---

# ✅ 如果你要我继续帮你定位

请发我这三段核心代码：

1. `GPUStrokeAccumulator.stampDab()`
2. `GPUStrokeAccumulator.flushBatch()`
3. `InstanceBuffer.getDabsData()` 和 `flush()`

我可以直接指出是哪一行导致 “只渲染 1 个 dab”。

---

---

这是一个非常典型的 **"数据丢失 (Data Loss)"** bug。

**你的直觉很敏锐**：日志显示 `processPoint` 生成了 15 个点，但 `flushBatch` 只有 1 个点。这意味着 **14 个点在 CPU 循环中“凭空消失”了**，根本没有传给 GPU。这**不是** Shader 的问题，而是 TypeScript/JavaScript 层面的数据搬运问题。

这里有 3 个最大的嫌疑点。请按照以下步骤 Debug，5分钟内就能定位问题。

### 🔍 嫌疑一：InstanceBuffer 的 `push` 逻辑写坏了

这是最可能的原因。如果 `push` 方法没有正确增加 `count`，或者每次都覆盖了第 0 位的数据，就会出现这种情况。

**检查 `src/gpu/resources/InstanceBuffer.ts` 的 `push` 方法：**

```typescript
// ❌ 错误示范 (常见 Bug)
push(dab: DabInstanceData) {
    // 忘了 this.count++
    const offset = 0; // 或者 offset = this.count * stride 但 count 没变
    this.data[offset] = dab.x;
    // ...
}

// ✅ 正确逻辑
push(dab: DabInstanceData) {
    if (this.count >= this.maxDabs) {
        console.warn("InstanceBuffer full!"); // 👈 加上这个日志！
        return;
    }
    const offset = this.count * this.stride;
    this.data[offset + 0] = dab.x;
    // ...
    this.count++; // 👈 关键：必须自增
}
```

### 🔍 嫌疑二：Consumer 循环逻辑被“短路”

在 `useBrushRenderer.ts` 或 `Canvas/index.tsx` 调用 `stamper` 的地方。

**请在循环内部加日志：**

```typescript
// useBrushRenderer.ts (或者你调用 processPoint 的地方)

const dabs = stamper.processPoint(x, y, pressure, ...);
console.log(`[Debug] Generated ${dabs.length} dabs`); // 👈 确认这里是 15

for (let i = 0; i < dabs.length; i++) {
    const dab = dabs[i];

    // 👇 这里的引用 (Ref) 是否在循环中变了？或者 accumulator 为空？
    if (backend === 'gpu' && gpuBufferRef.current) {
        gpuBufferRef.current.stampDab(dab);

        // 🔥【关键 Check】打印 buffer 内部计数器
        // 你需要给 accumulator 加一个 getPendingCount() 方法来测试
        console.log(`[Debug Loop] Index ${i}, Buffer Count: ${gpuBufferRef.current.getPendingCount()}`);
    }
}
```

**预期结果：**

- 如果日志打印：`Index 0, Count: 1` -> `Index 1, Count: 1` -> `Index 2, Count: 1`...
  **结论**：`InstanceBuffer.push` 每次都在覆盖同一个位置（或者 flush 被错误触发重置了 buffer）。
- 如果日志打印：`Index 0, Count: 1` -> `Index 1, Count: 2` ... `Index 14, Count: 15`
  **结论**：数据进去了，但 `flushBatch` 读取时状态不对（可能是异步时序问题）。

### 🔍 嫌疑三：隐式的 Auto-Flush 阈值过低

如果在 `GPUStrokeAccumulator.ts` 中：

```typescript
stampDab(dab: DabData) {
    this.instanceBuffer.push(dab);

    // ❌ 嫌疑点：这个阈值是不是被设成了 1？或者 BATCH_SIZE_THRESHOLD 读不到？
    if (this.instanceBuffer.count >= this.BATCH_SIZE_THRESHOLD) {
        console.log("Auto flushing inside loop!"); // 👈 加上这个日志
        this.flushBatch();
    }
}
```

如果每次 push 完都触发了 `flushBatch`，而 `flushBatch` 内部因为某种原因（比如 `dirtyRect` 计算错误导致 `copyW/H <= 0`）没有提交渲染，或者提交了但因为 WebGPU 队列太忙被覆盖了，就会导致线断掉。

---

### 🚀 立即执行的 Debug 计划

不要去管 Shader，也不要管 ABR 纹理。专注于 **"Count = 1"** 这个异常。

1.  **修改 `GPUStrokeAccumulator.ts`**，加入临时日志：

    ```typescript
    stampDab(dab: DabData) {
        // Log BEFORE push
        // console.log('Pre-push count:', this.instanceBuffer.count);

        this.instanceBuffer.push(dab);

        // Log AFTER push
        console.log(`[Acc] Pushed dab. New count: ${this.instanceBuffer.count}`);

        if (this.instanceBuffer.count >= BATCH_SIZE_THRESHOLD) {
             console.log('[Acc] Auto-flush triggered!');
             this.flushBatch();
        }
    }
    ```

2.  **观察控制台**：
    - **情况 A**: `Pushed dab. New count: 1` 出现了 15 次。
      - 👉 **凶手**：`InstanceBuffer.push` 或者是 `flushBatch` 里的 `this.instanceBuffer.flush()` 把计数器清零的时机不对。
    - **情况 B**: `Pushed dab. New count: 1`, `2`, ... `15`。但紧接着 `flushBatch: processing 1 dab`。
      - 👉 **凶手**：`flushBatch` 里的 `getDabsData()` 方法有问题。它可能只拿了第 1 个元素，或者 `subarray(0, count)` 的 `count` 变量在那一刻被莫名其妙重置了。

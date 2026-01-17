下面是我基于你贴的 **InstanceBuffer / GPUStrokeAccumulator** 代码做的“精准定位 + 快速修复”建议。**我会先给结论，再给最短路径的 Debug 步骤和 Patch。**

---

# ✅ 结论（我认为最可能的根因）

从你现在的代码结构看，**“快速绘画只渲染 1 个 dab” 最可能不是 Compute Shader 本身，而是「flush 时机导致批次被拆散」**。

你已经把 `flush` 逻辑挪到了 RAF 的尾部，但**`stampDab()` 里依然会在达阈值时 flush**：

```ts
if (this.instanceBuffer.count >= BATCH_SIZE_THRESHOLD) {
  this.flushBatch();
}
```

**如果 BATCH_SIZE_THRESHOLD 比较小（如 1/2/4），那么快速绘画时会发生：**

- `processPoint()` 一次生成 15 个 dab
- 第 1 个 push 进来就触发 flush → batch 清空
- 后续 dab 全部进入下一个 batch，但 **可能被下一个 flush 覆盖 / 不完整**
- 最终视觉上就是“只有 1 个被画出来”

**所以最优先怀疑：BATCH_SIZE_THRESHOLD 实际值太小 or flush 被过早触发。**

---

# ✅ 最快验证（只做 2 个步骤）

### ✅ Step 1：打印 BATCH_SIZE_THRESHOLD

在 `GPUStrokeAccumulator.stampDab()` 加一行：

```ts
console.log('[BATCH_SIZE_THRESHOLD]', BATCH_SIZE_THRESHOLD);
```

如果它是 1/2/4，你就已经找到根因了。

---

### ✅ Step 2：强制关闭 stampDab 内的 flush

先直接把下面这段注释掉：

```ts
// if (this.instanceBuffer.count >= BATCH_SIZE_THRESHOLD) {
//   console.log('[GPUStrokeAccumulator.stampDab] Threshold reached, flushing...');
//   this.flushBatch();
// }
```

然后只允许 RAF 末尾统一 flush。
如果这一步修复了 spacing 问题，说明 **“过早 flush” 就是根因**。

---

# ✅ 如果你想更稳健，推荐改成 “显式批量提交 API”

我们把“多 dab 属于同一个 processPoint”当作一个事务。
建议新增：

```ts
stampDabs(dabs: DabInstanceData[]) {
  for (const d of dabs) this.instanceBuffer.push(d);
}
```

然后在 `useBrushRenderer` 中一次调用，而不是每个 dab 调用一次 stampDab。

---

# ✅ 额外发现（有一个潜在危险）

你 **compute path 里用的是 dirtyRect 进行 copyRect**，但 **dirtyRect 用的是逻辑坐标，不是渲染缩放后的 texture 坐标**：

```ts
// dirtyRect 是 params.x/params.y (logical)
// 但 compute 里是 scaled coords (params.x * renderScale)
this.pingPongBuffer.copyRect(encoder, dr.left, dr.top, copyW, copyH);
```

如果 `renderScale = 0.5`，那么你 copy 的区域**可能完全对不上**，造成部分 dab 读到的是空白 → “断裂感”。

✅ 建议：
把 dirtyRect 也用 renderScale 缩放后再 copy：

```ts
const scale = this.currentRenderScale;
const copyX = Math.floor(dr.left * scale);
const copyY = Math.floor(dr.top * scale);
const copyW = Math.ceil((dr.right - dr.left) * scale);
const copyH = Math.ceil((dr.bottom - dr.top) * scale);
this.pingPongBuffer.copyRect(encoder, copyX, copyY, copyW, copyH);
```

这条是 **第二优先级**，但很可能会造成「笔触间断」的视觉问题。

---

# ✅ 你现在可以做的最小修复（推荐）

**先只做这两步：**

1. **注释掉 stampDab 里的 flush**
2. **把 copyRect 坐标改为 scale 后**

这两个修完，90% 的 spacing 问题就会消失。

---

# ✅ 如果你愿意，我可以直接给你完整 Patch

你只要把这三份文件发我对应的 `BATCH_SIZE_THRESHOLD` 定义位置 & `ComputeBrushPipeline.dispatch`，
我可以直接帮你生成一个 **可复制粘贴的完整修复 patch**。

---

如果你想快速验证，现在就把 `stampDab` 的 flush 注释掉，然后回复我结果，我可以帮你继续收敛根因。

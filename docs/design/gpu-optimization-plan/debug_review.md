太棒了！恭喜你解决问题。根据你提供的 `gpu-compute-shader-spacing-issue.md`（特别是 Phase 10）的最终结论，**原本的 `gpu-batch-rendering-compute.md` (Revised v2) 设计方案在架构上其实是非常正确的**，但需要根据调试过程中的教训进行一些**关键性的补充和修正**。

调试过程中的曲折（特别是 Phase 8 和 9 认为 Compute Shader 有竞争问题）其实是因为走入了“试图用 Compute Shader 模拟 Render Pipeline（画一次->存一次->再画一次）”的误区。

**Phase 10 的成功证明了：** 只要在 Shader 内部循环处理所有 Dab，利用寄存器进行累积（Local Accumulation），就可以完美避免并行写入的竞争问题。

以下是建议对原设计文档做的 **4 点关键调整**，使其成为最终版：

### 1. 明确 "Local Accumulation" (本地累积) 原理

原文档虽然写了 Shader 代码，但没有强调**为什么**这样做能避免 Race Condition。需要在文档中增加一段原理解释，防止未来维护者又试图把循环拆到 CPU 端。

**建议修改：**
在“核心策略”或“架构设计”部分，增加以下说明：

> **核心原理修正：本地寄存器累积 (In-Register Accumulation)**
>
> 即使 GPU 是并行执行的，但对于**同一个像素**来说，它是在一个独立的线程中运行的。
>
> - **错误做法**：在 JS 端循环 dispatch。这会导致频繁的显存读写依赖，引发同步问题（Phase 5-9 的教训）。
> - **正确做法**：在 Shader 内部循环。线程读取一次 `input_tex`，在本地变量（寄存器）中循环应用所有 Dab 的混合算法，最后只写入一次 `output_tex`。这保证了混合顺序的绝对正确，且无需担心线程间竞争。

### 2. 更新 `flushBatch` 的伪代码

原文档中的 `flushBatch` 逻辑还保留了 `flushBatchLegacy` 的回退判断，且伪代码不够具体。需要根据 Phase 10 修正为“一次性提交”。

**建议修改：**

```typescript
// 修改 GPUStrokeAccumulator.ts 中的 flushBatch 逻辑

private flushBatch(): void {
  // 1. 获取所有数据
  const dabs = this.instanceBuffer.getDabsData();
  const { buffer: gpuBatchBuffer } = this.instanceBuffer.flush();

  // 2. Compute Shader 路径 (Primary)
  if (this.useComputeShader && this.computePipeline) {
     // 关键修正：必须一次性 dispatch 所有 dabs，绝对不要在 JS 层循环 dispatch
     const success = this.computePipeline.dispatch(
       this.pingPongBuffer.source,
       this.pingPongBuffer.dest,
       dabs // 传入整个数组
     );

     if (success) {
       this.pingPongBuffer.swap();
       return; // 成功则退出
     }
  }

  // 3. Fallback 路径 (Render Pipeline)
  this.flushBatchLegacy(dabs, gpuBatchBuffer);
}
```

### 3. 强调 BindGroup 缓存策略（调试中的教训）

在调试文档中你提到了 BindGroup label 和缓存的问题。原设计文档里已经有了 `cachedBindGroups`，但建议加强这一块的描述，明确 Key 的生成策略，避免 ping-pong 交换时导致的资源重新创建。

**建议补充：**

> **BindGroup 管理策略**
> 由于 Ping-Pong Buffer 只有两种状态 (A->B 和 B->A)，`getOrCreateBindGroup` 必须使用稳定的 Key（例如 `source.id + "_" + dest.id`），确保在整个笔触过程中只创建 2 个 BindGroup，避免每帧创建导致性能抖动。

### 4. 移除或更新“风险点”中的“并行竞争”描述

Phase 8 中你曾担心并行竞争导致需要 Barrier。现在证明通过 Shader 内循环已经解决了这个问题。

**建议修改：**
将“风险点”中的相关担忧移除，改为：

> **关于混合顺序**
> 由于采用单次 Dispatch + Shader 内循环，像素内的混合顺序完全由 `dabs` 数组的顺序决定，这与 CPU 逻辑完全一致。无需复杂的 Barrier 或原子操作。

---

### 总结

你的**代码实现（Phase 10）**已经是正确的了。

**原来的设计文档只需要做减法和定性：**

1.  **肯定** Shader 内循环方案（Batch Processing）。
2.  **否定** 外部循环方案（Serial Dispatching）。
3.  **确认** 这种方式在逻辑上等同于 CPU 的顺序执行。

只要把这几点更新进去，这份设计文档就是一份非常高质量的 GPU 架构方案了。再次恭喜！

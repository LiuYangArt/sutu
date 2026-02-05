# 大画布 GPU 笔刷：Dual Brush 仍触发 maxBufferSize + 性能显著退化 + 预览链路“停更”（2026-02-05）

**日期**：2026-02-05  
**状态**：进行中（多根因候选并存，需补充证据锁定）

## 背景

近期已完成的大画布相关修复与复盘见：
- `docs/postmortem/2026-02-05-gpu-large-canvas-gpu-brush-preview-tearing.md`

本条复盘聚焦于：在大画布下 **GPU Compute 笔刷明显变慢**、**Dual Brush 仍出现 `maxBufferSize` 报错并伴随输出损坏**，以及更严重的 **连续绘制一段时间后 GPU 笔刷“画不出来”（预览停止更新 / 最终落图也错）**。

## 现象

1) **大画布下 GPU 笔刷明显比小画布慢很多**（同笔刷、类似笔画）  
2) **Dual Brush 在大画布仍报错**，且绘制出的 dab 预览/结果出现明显异常（“烂掉”）；小画布正常
3) **连续绘制一段时间后，GPU 笔刷“画不出来”（预览不更新）**；CPU 笔刷无该问题  
   - Debug Rects 中：primary/dual batch 仍在，但 **preview-update（黄框）不再出现**
   - “画不出来”时 **console 可能没有新增报错**（silent stall）

补充复现信息（来自最新测试）：
- **4000×4000** 已开始明显变慢，并出现报错
- **无 selection**（选区关闭）
- Batch-Union Preview 为默认值（未手动关闭）
- “最终图也错”（不仅仅是 preview 错）
- GPU render scale（Downsample）**强制 Off** 后，Dual Brush 仍异常（未改善）
- **不开 Dual Brush** 也能触发“画不出来”，且 **小画布也会出现**

用户截图报错信息：

```
Buffer size (4096000000) exceeds the max buffer size limit (536870912).
 - While validating [BufferDescriptor "Dawn_DynamicUploaderStaging""]
 - While calling [Queue].Submit([CommandBuffer])
```

以及另一组更明确关联 submit encoder label 的错误（出现频率高）：

```
Buffer size (2310144000) exceeds the max buffer size limit (536870912).
 - While validating [BufferDescriptor "Dawn_DynamicUploaderStaging""]
 - While calling [Queue].Submit([CommandBuffer from CommandEncoder "Dual Blend Encoder"])
```

另一个高频 Console 错误（与“黄框消失/画不出来”高度相关）：

```
[GPUStrokeAccumulator] Preview update failed: OperationError: Failed to execute 'mapAsync' on 'GPUBuffer': [Buffer "Preview Readback Buffer"] is destroyed.
Destroyed texture [Texture "PingPong Texture A"] used in a submit.
```

## 关键推断 1：`maxBufferSize` 并不等价于“dab/uniform 上传过大”

从代码看，`ComputeDualBlendPipeline.dispatch()` 只 `queue.writeBuffer()` **32 bytes** uniform（见 `src/gpu/pipeline/ComputeDualBlendPipeline.ts`），理论上不可能单独触发 `2.31GB` 级别 staging。

因此：**当前 `Dawn_DynamicUploaderStaging` 超限更像是“某处发生了超大 `queue.writeBuffer/writeTexture`（或内部 staging 聚合）并在某次 `queue.submit()` 触发分配/校验”**，而 encoder label 只是“触发 submit 的那一刻”。

> 备注：我们此前的直觉（“dabs/tiles 上传过大”）在 `safeWriteBuffer + MAX_DABS_PER_BATCH` 已落地后不再稳固；现在需要把视角扩展到 **`queue.writeTexture`**、**Dawn 的 staging 聚合策略**、以及 **submit 时统一分配 staging** 的可能性。

## 关键推断 2：`4,096,000,000` 与 `2,310,144,000` 两组数值仍可能对齐到“按行对齐的像素矩形”

虽然“`Dawn_DynamicUploaderStaging`”更像 upload（CPU→GPU），但两组数值恰好也能被 `rgba32float` 的 `bytesPerRow * height` 表达：

- `4,096,000,000 = 256,000 * 16,000`（对应 `copyRect.width=16000` 时 `bytesPerRow=16000*16=256000`）  
- `2,310,144,000 = 256,000 * 9,024`（同样对应 `width=16000` 的某个高度）

这提示我们：**仍有可能存在“某次按纹理行对齐的 staging/readback 申请被扩大”的路径**（例如 writeTexture/copyTextureToBuffer 的内部 staging），但目前无法从现有日志直接断言是哪条 API。

重要约束：在严格 `4000×4000` 的 `rgba32float` 局部 readback 场景里，`bytesPerRow=4000*16=64000`，要达到 `2.31GB` 需要 `height≈36096`，按理不可能 → **`2310144000` 很可能不是来自 4000×4000 的局部 readback**（要么画布更大、要么 rect/尺寸计算异常、要么来源不是 readback）。

结论：需要把“报错数值 ↔ 画布尺寸 ↔ rect 尺寸 ↔ 哪次 submit”对齐，才能锁定根因。

## 根因候选（按概率排序）

### A. Preview Readback 的“追不上 → pending rect 膨胀 → readback 进一步变大”的正反馈

机制推断：
- `requestPreviewUpdate()` 在 `updatePreview()` 进行期间会把新的 batch rect 合并进 `pendingPreviewRect`
- 大画布时 `updatePreview()` 更慢（GPU→CPU 拷贝 + JS 双层循环转 `ImageData`），因此更容易积压
- 积压会让 `pendingPreviewRect` 在一个更新周期内变成非常大的矩形（极端情况下接近整张纹理）
- 一旦 `copyBytes` 超过 `device.limits.maxBufferSize`（截图里为 `512MiB`）会触发 ValidationError；同时 preview 可能进入“部分更新/错乱”
- 当前合成落图使用 `previewCanvas`（WYSIWYG），所以 preview 的错乱会直接污染最终落图观感（表现为“dab 烂掉”）

### B. Dual Brush 放大 backlog 与带宽压力

Dual Brush 额外引入：
- secondary mask accumulate（`flushSecondaryBatches()`）
- stroke-level blend（`applyDualBlend()`）

其中 `flushSecondaryBatches()` 当前每段都会对 `dualMaskBuffer.copySourceToDest()` 做 **整纹理 copy**（O(画布面积)），大画布下会显著拖慢 GPU 队列，间接导致 preview readback 更难跟上，从而更容易触发 A 的正反馈。

### C. 主路径 ping-pong 的“保护拷贝区域偏大”，导致随 stroke 累积变慢

`flushBatch()` compute 路径在 dispatch 前会对 **累计 dirtyRect（stroke 级 union）** 执行 `pingPongBuffer.copyRect(...)`，以保证 swap 后 dest 仍保留历史结果。

当 stroke 跨越范围大时，累计 dirtyRect 会快速膨胀 → 每次 flush 都要 copy 更大区域（带宽主导），进一步推高 preview 更新耗时与积压。

### D. 资源生命周期/并发：readback buffer 或 PingPong texture 被提前 destroy（导致 preview 彻底停摆）

证据：出现 `Preview Readback Buffer is destroyed`、`Destroyed texture "PingPong Texture A" used in a submit`。

高概率触发方式（需要进一步对齐）：
- 任何会触发 `PingPongBuffer.resize()` / `setRenderScale()` / `recreateReadbackBuffers()` 的路径，
  若与 in-flight 的 `copyTextureToBuffer + mapAsync` 或最近一次 `queue.submit` 并发，会产生“destroyed resource used in submit/mapAsync”。
- 一旦 preview readback 的 mapAsync 链路被破坏，`updatePreview()` 可能持续失败/跳过，导致：
- 黄框不再出现（`lastPreviewUpdateRect` 不再被更新）
- previewCanvas 不更新 → composite 仍用 previewCanvas → 最终图也错

### E. Preview update 进入“永远 pending”的死等（黄框消失的另一种解释）

`updatePreview()` 若遇到 `previewReadbackBuffer.mapState !== 'unmapped'` 会直接 return 并标记重试；  
若 mapAsync 长时间 pending（GPU 队列 backlog 极大/提交失败/资源被 destroy 导致状态异常），可能形成：
- preview 一直不完成 → `currentPreviewPromise` 或 mapState 卡住
- requestPreviewUpdate 只会不断合并 pending rect，但 preview 永远不落地（黄框长期不出现）

## 新增关键候选：`rgba32float` 的 VRAM/带宽基线已经非常高（即使不开 Dual/WetEdge）

从代码资源分配看（`src/gpu/resources/PingPongBuffer.ts` + `src/gpu/GPUStrokeAccumulator.ts`）：

- `PingPongBuffer`：2 张 `rgba32float` 纹理（A/B）
- `pingPongBuffer.display`：1 张 `rgba32float` 纹理（当前在 `initializePresentableTextures()` 中被强制创建，即使 wet edge 关闭）
- `dualMaskBuffer`：2 张 `rgba32float` 纹理（即使 dual brush 关闭也会分配）
- `dualBlendTexture`：1 张 `rgba32float` 纹理（即使 dual brush 关闭也会分配）

以 `4000×4000` 为例：  
`4000*4000*16B ≈ 256MB/纹理` → 合计约 `6 * 256MB ≈ 1.5GB`（未计其它资源与驱动开销）。

这解释了两个现象：
- **大画布明显变慢**：GPU copy/compute 的实际吞吐会被带宽与显存压力主导（尤其是 dual mask 的整纹理 copy）。
- **稳定性变差**：一旦触发 validation error / 资源重建 / 内部 staging 申请，系统更容易进入“队列 backlog + mapAsync pending”的失稳状态。

> 这也说明“把内部格式从 `rgba16float` 换成 `rgba32float` 以简化 readback”在大画布上可能不可持续：它让性能/显存成本变成常态，而不是只在 readback 时付出代价。

## 为什么小画布正常、大画布异常

- 小画布下，O(区域面积) 的 GPU copy / readback 可能仍在可接受时间预算内，且 `copyBytes` 更难超过 `maxBufferSize`
- 大画布（尤其接近 10k~16k 级别）时，`rgba32float` 的 16B/px 使得 readback 很快跨过 512MiB 上限：
  - 以 `width=16000` 为例，`bytesPerRow=256000`，只要 `height > floor(512MiB / 256000) ≈ 2097`，就会超限

## 需要补的证据（下一步先做这些再改逻辑）

建议先补充最小可定位的运行时证据，用于回答三个关键问题：

1) `maxBufferSize` 对应的 **“是哪次 API 写入/提交”**？（writeBuffer / writeTexture / 内部 staging）  
2) silent stall 时，系统卡在 **`updatePreview()` 的哪一步**？（submit / mapAsync / JS conversion）  
3) “画不出来但无 console”时，是否发生过 **一次性的 validation error** 导致后续 submit 不再推进？

1) 在 `updatePreview()` 记录并输出（触发阈值时才打印，避免刷屏）：
   - `rectWidth/rectHeight`（logical）
   - `copyRect.width/copyRect.height`、`bytesPerRow`、`copyBytes`
   - `preferred.source`（`batch-union` vs `combined-dirty`）
   - `previewUpdatePending/currentPreviewPromise != null` 持续时长（识别“永远 pending”）
2) 在 dual brush 路径记录：
   - `flushSecondaryBatches()` 的段数与每段 bbox（或总 bbox）
   - `dualMaskBuffer.copySourceToDest()` 的频率与是否为整纹理 copy
3) 捕获 `device.onuncapturederror`（把 ValidationError 变成可结构化的日志，至少记录 error.message + 最近一次 encoder label）
4) 复现条件补齐到复盘里：
   - 画布尺寸（尤其是否接近 16k 级别）
   - 是否开启 selection（selection 相关逻辑会让 `updatePreview()` 的 CPU loop 更慢）
   - 发生 `maxBufferSize` 时是否刚好在切换 Dual Brush / Pattern / 纹理（排除超大 `writeTexture`）

## 可行的缓解/修复方向（不在本次落地）

### 短期（止血：先不崩）

- **避免 silent stall**：当 `currentPreviewPromise` 超时/长时间 pending 时，强制 `previewUpdatePending=false` 并允许后续更新（或在 UI 上提示 GPU 失稳并 fallback）
- 对 preview readback 增加硬上限：若 `copyBytes > device.limits.maxBufferSize`，按水平 strip 拆分 `copyTextureToBuffer`（每条高度 `<= floor(maxBufferSize / bytesPerRow)`），避免单次超限
- 对 preview 更新引入“面积/时间预算”：超过预算优先更新更靠后的 batch rect，避免 `pendingPreviewRect` 合并成整图

### 中期（显著改善：降低 readback 压力）

- 引入 `rgba8unorm` 的 “presentable texture”（GPU 侧 downconvert），把 readback 从 16B/px 降到 4B/px，并且 **直接 memcpy 到 ImageData**（减少 JS per-pixel loop）
- 尽量把“即使 feature 关闭也分配的大纹理”变成 **lazy/按需**（dualMaskBuffer/dualBlendTexture/displayTexture）
- Dual mask 的 ping-pong 保护拷贝：从整纹理 copy 改为增量 copy（只同步必要区域），降低 O(画布面积) 带宽

### 长期（根治：尽量不做 GPU→CPU readback）

- L1：显示/合成链路迁到 WebGPU（直接显示 GPUTexture），将 preview 与 layer composite 从 CPU 迁移到 GPU
- L2：在 L1/M3 之后再评估默认内部格式 `rgba32float → rgba16float`

## 经验教训

1) `rgba32float` + CPU readback 不具备“无限可扩展性”：大画布必须分段/降采样/或改为 GPU 显示  
2) dirty-rect 不是万能：当 pending/积压允许 rect union 无限膨胀时，会形成正反馈并最终超限  
3) Dual Brush 下任何整纹理 copy 在大画布上都会成为灾难级瓶颈，需要强约束与可观测性  
4) 一次 validation error 可能把系统推进到“预览永远 pending / 画不出来”的软死状态：必须把错误变成“可检测、可恢复、可降级”的状态机逻辑

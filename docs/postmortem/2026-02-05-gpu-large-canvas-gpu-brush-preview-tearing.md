# 大画布下 GPU 笔刷绘制中“碎裂/不连贯”（预览链路）

## 背景

在画布尺寸较大时（例如 5000×3000），GPU 笔刷在**绘制过程中**会出现笔触“碎裂/不连贯/白洞”；但**停笔后**最终落在图层上的结果通常正确。CPU 笔刷无该问题。最简单的硬圆头也可复现，和笔刷参数相关性较弱。

这类“绘制中出问题、停笔后正确”的现象，优先怀疑 **preview 链路**与 **GPU/CPU 同步时序**，而不是最终落图算法本身。

## 现象（复现要点）

- 画布：5000×3000。
- 笔刷：硬圆头（hardness=100），无纹理、无 dual、无 wet edge（也可在其它特性下更容易触发）。
- 现象：绘制过程中预览出现断裂；停笔后结果补齐/正确。

## 根因（结论）

问题来自两处与画布尺寸线性相关的高开销点，导致 `updatePreview()` 追不上 RAF 节奏，预览“欠账”表现为断裂；而 `prepareEndStroke()` 会等待 GPU 完成并强制做一次预览同步，所以停笔后结果正确。

### 1) `updatePreview()` 每次整图读回（readback）

旧实现：每次预览更新都对整张 `rgba32float` 纹理执行 `copyTextureToBuffer` 并 `mapAsync` 读回。

- 5000×3000×16B ≈ 240MB/次（仅一次 readback 的数据量）
- 在绘制过程中每帧/每 flush 触发，会使 GPU→CPU 同步与内存带宽成为瓶颈
- 结果：预览更新滞后，出现肉眼可见的断裂/白洞

### 2) parametric compute 主路径每次全画布拷贝（copyTextureToTexture）

旧实现：`flushBatch()`（parametric compute）在 dispatch 前使用 `copySourceToDest()` 做整画布拷贝来保持累积结果。

- 同样与画布尺寸线性相关（5000×3000 级别非常昂贵）
- 即便笔刷很简单/很小，也会被画布带宽拖垮

## 解决方案（已实施）

目标：不改变最终算法结果，只把“每帧 O(画布面积)”改为“每帧 O(dirty-rect)”。

### A. `updatePreview()`：整图读回 → dirty-rect 读回

- 继续沿用现有 `getPreviewUpdateRect()` 机制（优先 batch union，fallback combined-dirty）
- 将逻辑 rect 转换为纹理 copy rect（考虑 `renderScale`、clamp、pad）
- `copyTextureToBuffer` 只拷贝局部区域，并按需增长 `previewReadbackBuffer`
- 读取时用“局部 stride + origin 偏移”采样，再 `putImageData` 写回对应区域

新增工具函数：
- `src/gpu/utils/textureCopyRect.ts`：`computeTextureCopyRectFromLogicalRect()`（含对齐/缩放/裁剪）

### B. `flushBatch()`（parametric compute）：全画布 copy → dirtyRect(+pad) copyRect

- 将 compute 分支的 `copySourceToDest()` 替换为 `pingPongBuffer.copyRect()`（逻辑坐标）
- 以 stroke 累计 `dirtyRect` 为主，并加少量 padding（避免边缘写入漏拷）

### C. 预热 readback：整图预热 → 小块预热

- `prewarmDualReadback()` 改为只读回极小区域（例如 16×1），避免大画布启动时临时分配/拷贝超大 buffer

## 结果（当前状态）

- ✅ 用户验证：大画布下 GPU 笔刷绘制过程不再断裂/白洞，预览连续。
- ✅ 单测：`src/gpu/utils/textureCopyRect.test.ts` 覆盖 scale/clamp/pad。

## 新暴露问题（待处理）

上述修复消除了预览“欠账”导致的断裂，但也更清晰地暴露了另外两类瓶颈/稳定性问题：

### 1) 大画布每笔结束时卡顿（Stroke End Stall）

现象：大画布下，每次 `endStroke`（停笔落图）会“卡一下”。

高概率原因：
- `prepareEndStroke()` 会 `await device.queue.onSubmittedWorkDone()` 并且**无条件** `await updatePreview()`，即使预览已经更新完成也会再做一次同步
- `compositeFromPreview()` 使用 `getImageData/putImageData` + JS 逐像素 Porter-Duff 合成，dirty rect 较大时会阻塞主线程

### 2) Dual Brush/其它特性触发 WebGPU 报错：Buffer size exceeds maxBufferSize

现象：大画布下勾选 Dual Brush（或开启其它特性）时，出现 Dawn 校验错误：

- `Buffer size (5184000000) exceeds the max buffer size limit (536870912).`
- 关联 encoder label：`Brush Batch Encoder` / `Dual Blend Encoder`

初步判断：某处在一次提交内触发了超大 `queue.writeBuffer/writeTexture`（Dawn 内部会创建 `Dawn_DynamicUploaderStaging` staging buffer），导致单次 staging buffer 申请超过 `device.limits.maxBufferSize`（常见为 512MB）。

这类问题需要“更稳妥的处理方法”：
- 对所有上传路径做硬性上限与分块（chunked upload），避免单次提交产生超大 staging
- 在异常放大（例如 dabs/tiles 数量异常）时快速降级（CPU fallback）并输出可定位日志

## 经验教训

1) **任何 per-frame O(画布面积) 的 GPU↔CPU 同步，在大画布必出问题**：必须 dirty-rect 化。
2) **WebGPU 的资源/上传也有硬上限**（如 `maxBufferSize`）：不能假设“数组再大也能一次 writeBuffer”。
3) **stroke end 的“同步 + CPU 合成”是最容易被忽略的卡顿点**：需要快路径（无 selection 时直接 `drawImage` 合成）或 GPU 化。

## 后续（下一步）

将后续改造（按优先级/依赖拆解）写入计划文档：
- `docs/plans/2026-02-05-gpu-large-canvas-gpu-brush-stability-roadmap.md`

重点：
- P0：upload/dispatch 安全化（分块 + 上限 + 定位日志），彻底消灭 `maxBufferSize` 报错
- P1：stroke end 合成快路径与 `prepareEndStroke()` 的无谓同步消除
- L：长期方案评估（LayerRenderer WebGPU 化、纹理格式改回 `rgba16float`）


# 大画布 GPU 笔刷稳定性与渲染架构 Roadmap（2026-02-05）

> 本文目标：把“接下来要做什么、怎么做、先后顺序与依赖关系”写成可直接落地的设计文档。  
> 已完成的修复复盘见：`docs/postmortem/2026-02-05-gpu-large-canvas-gpu-brush-preview-tearing.md`

## 1. 背景与当前状态

### 已完成（现状）

大画布（5000×3000）下 GPU 笔刷“绘制中碎裂/不连贯”的核心原因是 preview 链路的整图读回与 compute 路径的整图拷贝导致预览追不上 RAF。已完成以下修复并由用户确认“绘制中不再断裂”：

- `updatePreview()` 从整图 readback 改为 dirty-rect readback（带 `renderScale`、pad、clamp）
- parametric compute 主路径从全画布 copy 改为 `dirtyRect(+pad)` 的 `copyRect`
- `previewReadbackBuffer` 改为“小起步 + 按需增长”，避免大画布常驻超大 `MAP_READ` buffer
- `prewarmDualReadback()` 改为小块预热，避免大画布启动时的巨额临时分配

### 新问题（当前痛点）

1) **每笔结束卡一下（Stroke End Stall）**  
2) **大画布 + Dual Brush/其它特性触发 WebGPU 报错：`Buffer size (...) exceeds the max buffer size limit (...)`**  
   - 典型为 `maxBufferSize=536870912`（512MB），错误发生在 Dawn 内部 `Dawn_DynamicUploaderStaging`（常见于一次 `queue.writeBuffer/writeTexture` 过大）

## 2. 目标与成功标准

### 目标（按优先级）

**P0（稳定性）**：彻底消灭大画布下的 `maxBufferSize` 报错（Dual Brush/其它特性组合也不触发）。  
**P1（体验）**：大画布下 stroke end 不再明显卡顿（肉眼无“停一下”的感觉）。  
**P2（可持续）**：把“预览/合成/落图”链路的 O(画布面积) 同步点逐步移除或 GPU 化，为后续架构升级铺路。

### 成功标准（可验证）

- 5000×3000：
  - 开启 Dual Brush、Scatter/Pattern/Noise/WetEdge 等常见组合，快速连续画长笔画：无 WebGPU ValidationError
  - 每次停笔：不再出现明显停顿
- Debug 视角：
  - 能打印出关键 batch/dispatch/upload 的尺寸统计（定位异常放大时有足够证据）
- 回归：
  - 不改变最终落笔的视觉结果（允许极小的浮点差异，但必须可解释/可控）

## 3. 总体策略与依赖关系（推荐顺序）

> 先把系统“打不死”（P0），再把体验“变顺”（P1），最后才考虑大规模重构（L1/L2）。

1) **P0：上传/dispatch 安全化（必须先做）**  
   - 依赖：无  
   - 产物：分块 upload、硬上限、异常降级、可定位日志
2) **P1：stroke end 快路径（可与 P0 部分并行，但建议 P0 打底后合并）**  
   - 依赖：建议基于 P0 的日志/指标验证优化效果
3) **L1：LayerRenderer 全面迁到 WebGPU（长期，大项目）**  
   - 依赖：P0（稳定性与限额机制）、P1（过渡期体验可接受）
4) **L2：纹理格式 `rgba32float → rgba16float`（中长期）**  
   - 强依赖：要么完成 L1（减少 CPU readback 需求），要么先做“GPU→8bit 预览输出”的替代方案  
   - 不建议先于 P0/P1 执行（对当前两大问题不是根治）

## 4. P0：Upload/Dispatch 安全化（彻底灭掉 maxBufferSize）

### 4.1 设计原则

- **任何一次 `queue.writeBuffer/writeTexture` 都不得超过 `device.limits.maxBufferSize`**  
  （建议再乘以安全系数，比如 0.5，避免实现差异/对齐/内部 staging 放大）
- **避免构建超大连续 ArrayBuffer**：不创建 `new ArrayBuffer(stride * count)` 这种“随数据量线性膨胀”的临时块
- **异常放大要可见且可控**：当 dabs/tiles 数量异常时，优先“降级/限速/分段”，而不是直接崩溃

### 4.2 需要覆盖的上传路径（清单）

以下文件包含高频 `queue.writeBuffer`，且当前实现存在“一次性写入大块”的风险点：

- `src/gpu/pipeline/ComputeBrushPipeline.ts`
- `src/gpu/pipeline/ComputeTextureBrushPipeline.ts`
- `src/gpu/pipeline/ComputeDualMaskPipeline.ts`
- `src/gpu/pipeline/ComputeDualTextureMaskPipeline.ts`
- `src/gpu/resources/InstanceBuffer.ts`（极端情况下也可能超限）
- `src/gpu/resources/TextureInstanceBuffer.ts`（同上）

### 4.3 具体实现方案（决策已给出）

#### 4.3.1 增加统一的“安全写入”工具函数

新增工具文件（内部使用）：

- `src/gpu/utils/safeGpuUpload.ts`
  - `const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024 * 1024`（64MB，保守且足够小）
  - `getMaxChunkBytes(device): number = Math.min(device.limits.maxBufferSize, DEFAULT_MAX_CHUNK_BYTES)`
  - `safeWriteBuffer(device, dstBuffer, dstOffset, src, srcOffset, size, label)`
    - 如果 `size <= maxChunkBytes`：一次写入
    - 否则循环按 chunk 写入：`queue.writeBuffer(dstBuffer, dstOffset + written, src, srcOffset + written, chunkSize)`
    - 若 `size > dstBuffer.size` 或越界：抛错并带 label（防止 silent corruption）

说明：
- 该工具的目标不是极限性能，而是**稳定性兜底**；性能优化应建立在稳定之后
- 64MB 是经验值；后续可根据设备/性能调参

#### 4.3.2 Compute pipelines：去掉“整段 ArrayBuffer + 一次 writeBuffer”

以 `ComputeBrushPipeline.dispatch()` 为例（其它 pipeline 同步处理）：

**当前风险点**：
- `const dabData = new ArrayBuffer(this.dabStride * batchCount); ... writeBuffer(dabBuffer, 0, dabData)`
- `const uniformData = new ArrayBuffer(this.uniformStride * dispatchCount); ... writeBuffer(uniformBuffer, 0, uniformData)`

**改造方案（推荐）**：

- dab upload：按 batch 写入，不再拼成一个大 ArrayBuffer
  - 复用一个 `ArrayBuffer(this.dabStride)`（或 `Float32Array` view）
  - 对每个 batch：
    - `packDabDataInto(batch, dabView, 0)`
    - `safeWriteBuffer(device, dabBuffer, batchIndex * dabStride, dabDataChunk, 0, dabStride, 'ComputeBrush dab upload')`

- uniform upload：按 tile/批量写入（tile 数可能很大）
  - 方案 A（最简单）：每个 tile 一个 `ArrayBuffer(uniformStride)`，逐个 `safeWriteBuffer`
  - 方案 B（更高效，仍稳定）：用 `chunkUniformBuffer = new ArrayBuffer(uniformStride * CHUNK_TILES)`，每次填满一段再写入
    - `CHUNK_TILES = floor(maxChunkBytes / uniformStride)`
    - 避免一次 writeBuffer 太大，也减少 writeBuffer 调用次数

这一步的关键收益：
- 即便出现极端 dabs/tiles 放大，也不会触发单次 staging >512MB 的硬错误
- 同时避免 JS 侧巨大临时内存分配（更稳）

#### 4.3.3 资源容量增长：禁止无限 grow，改为“固定容量 + 分段处理”

当前 `ensureUniformCapacity/ensureDabCapacity` 会按需求 grow buffer：在异常放大时会尝试创建超大 GPUBuffer（必然失败）。

设计决策：
- **不再按 `required` grow 到“足够装下全部”**
- 改为：
  - 固定/上限容量：`maxBatchesInBuffer = floor(maxBufferSize / dabStride)`（再乘安全系数，比如 0.5）
  - 分段 dispatch：一次只处理 `segmentBatchCount <= maxBatchesInBuffer` 的 batch
  - segment 之间保持 ping-pong 逻辑连续（同一个 encoder 内可多段 pass，也可拆成多次 submit；优先同 encoder，减少同步）

实现要点（对 ComputeBrush/Texture/DualMask/ DualTextureMask 通用）：
- 由 pipeline 自己控制分段循环（caller 只传 dabs 与 bbox/rect）
- 分段边界必须正确维护：
  - 每个 batch 完成后，仍需要 `copyTextureToTexture`（dirty bbox 范围）以便下一 batch 读到累积结果
  - segment 的最后一个 batch 与下一 segment 的第一个 batch 之间也同理

#### 4.3.4 GPUStrokeAccumulator：二级安全阈值（避免 secondary 暴涨）

大画布 + Dual Brush 更容易触发异常放大，原因之一是 secondary buffer 没有像 primary 一样的 auto-flush 约束。

增加二级阈值（简单且有效）：
- 在 `stampSecondaryDab()` 内部增加：
  - `if (secondaryInstanceBuffer.count >= MAX_SAFE_SECONDARY_BATCH_SIZE) flushSecondaryBatches()`
  - `if (secondaryTextureInstanceBuffer.count >= MAX_SAFE_SECONDARY_BATCH_SIZE) flushSecondaryBatches()`
- `MAX_SAFE_SECONDARY_BATCH_SIZE` 初始建议 256（比 primary 64 更宽松，避免过于频繁 submit）

同时增加“硬上限防爆”：
- 若一次 `applyScatter()` 返回的 positions 数超过上限（如 10_000），直接：
  - clamp positions（只取前 N 个）
  - 并 `requestCpuFallback('Dual scatter too many instances')` 或记录警告

> 注：这里属于“稳妥兜底”，不代替对 scatter 参数/算法的根因修复，但能防止直接把系统打崩。

### 4.4 定位与可观测性（必须一起做）

新增 debug 日志（可通过全局 flag 开关，避免默认刷屏）：
- 在以下位置打印：
  - primary/texture/dual/dualTexture：`dabs.length`、`batchCount`、`dispatchCount`、预计上传字节数、dirty bbox/rect
- 触发条件：
  - `if (estimatedUploadBytes > 64MB)` 或 `if (dabs.length > 10_000)` 才打印（减少噪音）

目标：当再次出现异常时，日志能直接回答“是哪一路、哪一步、哪个 count/bytes 爆了”。

### 4.5 P0 验收用例

- 5000×3000：
  - dual brush on/off 来回切换
  - 开启 scatter/count/纹理/噪声/wet edge 等组合
  - 快速连续画长笔画（尤其是跨大距离）
  - 观察：无 GPUValidationError；若触发 fallback，有明确 reason 与尺寸日志

## 5. P1：Stroke End Stall 优化（每笔结束不再卡）

### 5.1 现状根因（对应代码）

`src/gpu/GPUStrokeAccumulator.ts`：
- `prepareEndStroke()`：
  - `await device.queue.onSubmittedWorkDone()`
  - 若有 `currentPreviewPromise` 也 await
  - 最后无条件 `await updatePreview()`
- `compositeFromPreview()`：
  - `getImageData/putImageData` + JS 逐像素 Porter-Duff over
  - dirty rect 大时非常重（主线程阻塞）

### 5.2 具体实现方案（按收益排序）

#### 5.2.1 取消“无条件 final updatePreview”（只在需要时做）

设计决策：`prepareEndStroke()` 只在下列情况之一成立时才调用 `updatePreview()`：

- `previewNeedsUpdate === true`
- 或者存在 `pendingPreviewRect`
- 或者 `lastPreviewUpdateRect` 不包含当前 `dirtyRect`（考虑 integer clamp 与 pad，允许 1px 容差）

这样能避免“绘制过程中已经追上了，但停笔又强制做一次同步”的多余开销。

#### 5.2.2 composite 快路径：无 selection 时直接 `drawImage`

设计决策：当没有 selection mask 时：

- 不做 `getImageData/putImageData`
- 直接在 `layerCtx` 上：
  - `globalCompositeOperation = 'source-over'`
  - `globalAlpha = opacity`
  - `drawImage(previewCanvas, rect.left, rect.top, rectWidth, rectHeight, rect.left, rect.top, rectWidth, rectHeight)`

优点：
- 走浏览器内部的高性能路径，基本消除“每笔结束卡一下”
风险：
- 与手写 Porter-Duff 在极端边界（色彩空间/取整）可能存在极小差异  
缓解：
- 仅在无 selection 时启用；selection 仍走旧逻辑保证一致

#### 5.2.3 selection 场景优化（可选，后续再做）

如果 selection 场景也需要更快（例如用户常用选区）：

- 方案 A（仍走 2D）：在一个临时 canvas 上先 draw stroke，再用 `destination-in` 应用 mask，再 draw 到 layer
  - 优点：避免 JS 逐像素循环
  - 风险：需要把 selection mask 以图像方式提供（可能需要把 ImageData 缓存成 canvas/bitmap）
- 方案 B（GPU）：把 selection mask 作为纹理参与 GPU 合成（更适合配合 L1）

### 5.3 P1 验收用例

- 5000×3000，关闭 selection：
  - 连续画 20 笔，每次抬笔不再出现明显停顿
- 开启 selection：
  - 结果正确（可以暂时仍慢，但不能错误）

## 6. 长期方案 L1：LayerRenderer 全面迁到 WebGPU

> 目标：把“图层合成 + 预览显示 + 落图提交”整体 GPU 化，彻底移除 2D readback 与 CPU 合成瓶颈。

### 6.1 目标与范围

- 用 WebGPU 管理每个图层的像素数据（`GPUTexture`）
- WebGPU 完成图层 blend/opacity 合成并输出到显示
- GPU 笔刷直接写入 active layer 的 GPUTexture（不再依赖 previewCanvas → layerCtx 的 CPU 合成）

### 6.2 API 变更（建议的最小对外形态）

新增 `WebGPULayerRenderer`（不替换旧的，先并存）：

- `createLayer(id, options): LayerHandle`
- `removeLayer(id)`
- `setLayerOrder(order)`
- `updateLayer(id, props)`
- `compositeToScreen(preview?: { activeLayerId, previewTexture, opacity }): void`
- `readLayerImageData(id, rect?): ImageData`（仅用于导出/调试，默认不用）

旧的 `LayerRenderer` 保留作为 fallback 与对照（同一套单测/对比工具）。

### 6.3 关键技术点（必须提前锁定）

1) **Blend mode 对齐**  
   - 现有 `LayerRenderer` 直接依赖 canvas `globalCompositeOperation`
   - WebGPU 需要在 shader 中实现（normal/multiply/screen/overlay/...）
   - 需要一个“基准对比集”：小画布 + 固定输入，逐 blend mode 做像素 diff（允许极小误差阈值）

2) **色彩空间与预乘 alpha**  
   - Canvas2D 默认在 sRGB/预乘 alpha 管线中工作
   - WebGPU 端建议内部统一用线性空间浮点（16f/32f），在最终呈现时做 sRGB 转换
   - 必须定义“与当前行为一致”的最小标准：肉眼一致优先，像素级完全一致不强求（但需可解释）

3) **显示输出（替换 compositeCanvas）**  
   - 最终应渲染到 WebGPU `canvas` context（preferred）
   - 与现有 React 组件集成方式需要设计：Canvas 组件增加一个 WebGPU 渲染层（或直接替换原 compositeCanvas）

4) **selection/mask**  
   - selection mask 目前在 CPU（ImageData）上访问
   - WebGPU 化需要把 mask 缓存成 `rgba8unorm` texture（alpha 通道）

5) **Resize / 导入导出**  
   - resize：GPU 侧重新分配 texture 并复制（可选 resample）
   - 导入：`queue.writeTexture` 上传 ImageData
   - 导出：`copyTextureToBuffer` 读回（仅导出时允许慢）

### 6.4 分阶段里程碑（推荐落地顺序）

**M0：基础设施**
- 新增 WebGPU renderer 类与显示 canvas（不影响现有路径）
- 做一个“单层显示”demo（把一张 GPUTexture 显示出来）

**M1：图层合成最小集**
- 支持：normal + opacity + visibility
- 与 `LayerRenderer.composite()` 在小画布下做视觉对比

**M2：扩展 blend modes**
- 覆盖 `BlendMode` 映射表中的主要模式（先做常用：multiply/screen/overlay/darken/lighten）
- 引入像素对比工具与误差阈值

**M3：active layer 与 GPUStrokeAccumulator 对接**
- GPU 笔刷直接写 active layer texture（不再 CPU 合成）
- preview 也直接来自 GPU（无需 readback）

**M4：全量迁移与删除中间层**
- 所有层都使用 GPUTexture
- 2D `LayerRenderer` 退场/仅保留 fallback

### 6.5 风险与控制

- 工程量大：必须阶段化，且每阶段都有可运行产物与回归集
- 兼容性：WebGPU 设备/浏览器差异，需要 fallback（保留 Canvas2D 路径）

## 7. 长期方案 L2：纹理格式 `rgba32float → rgba16float`

> 目标：降低 VRAM/带宽占用，提高大画布可用性，并为 L1 的“全 GPU 管线”铺路。

### 7.1 为什么不建议现在就做

当前 preview/落图依赖 CPU readback（`rgba32float` 读回后按 Float32 取样），因此：
- 直接改成 `rgba16float` 会引入 CPU 侧 half-float 解码与误差问题
- 对 “maxBufferSize staging 超限”并非根治（5GB 级别即使减半仍会爆）

### 7.2 改动范围（涉及哪些资源）

核心资源：
- `src/gpu/resources/PingPongBuffer.ts`：`format`
- `src/gpu/GPUStrokeAccumulator.ts`：`dualBlendTexture` 的 format
- 所有使用 storageTexture 的 compute shaders 与 pipeline bindGroupLayout：
  - `storageTexture: { format: 'rgba32float' }` → `'rgba16float'`
  - WGSL 中 `texture_storage_2d<rgba32float, ...>` → `rgba16float`

### 7.3 分阶段方案（与 L1 的关系）

**F0：加 Feature Flag**
- 配置层增加：`gpuTextureFormat: 'rgba32float' | 'rgba16float'`
- 默认仍为 `rgba32float`

**F1：Shader/Pipeline 双版本**
- 为每条 pipeline 提供两套 shader/pipeline（或用字符串模板生成）
- 确保功能一致后再开放开关

**F2：移除 CPU readback 依赖（推荐与 L1/M3 绑定）**
- 当 preview/display 不再需要 Float32 readback 后，再默认切换到 `rgba16float`

**F3：回归与对比**
- 小画布像素对比 + 大画布性能/内存指标

## 8. 测试与验收清单（统一）

### 手工测试（必须）

1) 5000×3000：
   - GPU 硬圆头：快速长笔画，绘制中连续，停笔不卡顿
2) Dual Brush：
   - 开/关、多种 blend mode，快速绘制，无报错
3) 组合特性：
   - Scatter/Pattern/Noise/WetEdge 按常用组合验证，确保不触发 validation error
4) selection：
   - 有/无 selection，结果正确（性能后续再优化）

### 自动化（建议逐步补齐）

- 对 `LayerRenderer` 与未来 `WebGPULayerRenderer`：小画布像素对比基准集（blend modes + opacity）
- 对 P0：在 dev/debug 下新增一条“upload size 断言”测试（超阈值直接 throw，避免悄悄退化）

## 9. 最终推荐实施顺序（结论）

1) **先做 P0（分块 upload + 上限 + 日志 + secondary auto-flush）**  
2) **再做 P1（prepareEndStroke 去掉无谓 final update + 无 selection 的 drawImage 合成快路径）**  
3) **若仍需更大幅度提升：启动 L1（WebGPU LayerRenderer，按 M0→M4 阶段推进）**  
4) **在 L1/M3 后再推进 L2（默认切到 rgba16float）**


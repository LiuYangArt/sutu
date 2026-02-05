# GPU-First 笔刷与渲染架构设计（8K 目标，Tile 化）

**日期**：2026-02-05
**状态**：设计草案（已对齐）

## 1. 目标与成功标准

### 目标

- 显示分辨率以 **4K** 为主，画布分辨率 **最低 4K**。
- **32GB NVIDIA 台式显卡**：画布目标上限 **8K**。
- **4060 移动版**：画布目标上限 **4K**。
- 彻底移除 **GPU→CPU readback + CPU 合成** 作为实时绘画路径。
- **可见层数不设上限**，视觉正确性不因配置而变化。
- 通过 **tile/虚拟纹理** 控制显存常驻与带宽压力。

### 成功标准

- 32GB 显卡：8K 画布单层连续 30s 绘画，无停画、无 WebGPU ValidationError、输入延迟稳定。
- 4060 移动版：4K 画布同样满足上述稳定性指标。
- 4K 对比当前 Canvas2D：误差可控（8-bit 误差 ≤ 1~2，且可解释）。
- 可见层数增加时，视觉结果正确，且显存峰值可控（tile 常驻上限稳定）。
- 导出/截图仅在用户触发时 readback，颜色一致。

## 2. 非目标（本阶段不做）

- 不追求像素级完全一致（允许极小误差并可解释）。
- 不做多实例/网络协作画布。
- 不在实时绘画中执行任何 readback。
- 不要求“全画布全层纹理常驻显存”。

## 3. 核心决策

### 3.1 纹理格式策略（已定）

- **Layer 存储**：`rgba8unorm`（线性空间）
- **Active stroke scratch**：`rgba16float`
- **显示输出**：线性 → sRGB
- **导出/截图**：显式 readback，仅在需要时执行

理由：`rgba32float` 在 8K 下显存/带宽不可接受；`rgba8unorm` 作为最终目标格式更合理，`rgba16float` 仅在 active stroke 期间保障混合精度。

### 3.2 Tile/虚拟纹理（新增）

- 画布按固定 **tile** 切分（建议 256 或 512）。
- 每层由 **tile 纹理集合** 表示，非活动层不做全画布常驻。
- 采用 **LRU** 或相似策略控制 GPU 常驻 tile 数量。

### 3.3 可见 tile 合成缓存（新增）

绘画只发生在 active layer，但需要正确显示上下层。因此引入可见 tile 缓存：

- `belowComposite`：active layer 之下所有层 **可见 tile** 合成缓存。
- `aboveComposite`：active layer 之上所有层 **可见 tile** 合成缓存。
- 缓存仅在对应 tile 的层内容/属性（opacity/blend/visibility/顺序）变化时失效。

### 3.4 降级策略（新增）

- **优先**降画布分辨率（8K → 6K → 4K）。
- **其次**降低离屏缓存保留时间或降低离屏缓存精度。
- **不降低可见层数**，保证视觉正确性。

### 3.5 同纹理读写冲突修复（新增）

`commitStroke()` 不能在同一 pass 中对 `activeLayer` 既读又写：

- 为 active layer 引入 **`activeLayerTmp`**（或 ping-pong）。
- 提交路径：`activeScratch + activeLayer -> activeLayerTmp`，然后交换句柄。

### 3.6 设备能力探测（新增）

- 启动时探测 `maxTextureDimension2D`、格式支持、可用显存预算。
- 超出上限时按 3.4 规则降级。

## 4. 架构概览

### 4.1 模块划分

1. **GpuLayerStore**
   维护每层 tile 纹理、可见性/opacity/blendMode 元数据。

2. **TileResidencyManager（新增）**
   维护 tile 常驻预算、LRU、上传/回收与系统内存缓存。

3. **GpuLayerComposer**
   维护 `belowComposite`、`aboveComposite`、`display` 的 **可见 tile 缓存**；负责合成。

4. **GPUStrokeAccumulator（改造）**
   输出到 `activeScratch (rgba16float)` 的 **可见 tile**；`commitStroke()` 合成回 active layer。

5. **WebGPU Display**
   直接显示 `display` tile 集合（不经 CPU Canvas2D）。

### 4.2 数据流

- 输入点 → `GPUStrokeAccumulator` 写入 **scratch tiles**
- 每帧合成：对 **可见 tile 集合** 进行
  `belowComposite + activeScratch + aboveComposite -> display`
- 结束笔触：对涉及的 tiles 执行
  `activeScratch + activeLayer -> activeLayerTmp`，然后 swap
- 导出/截图：通过 GPU 进行 **tile-based 合成 + 线性→sRGB + dither**，再 readback（非实时）

## 5. 关键接口变化（Breaking）

1. **LayerRenderer.composite()**
   由 `GpuLayerComposer` + tile 缓存替代，Canvas2D 仅作为 fallback。

2. **Preview 路径**
   `getPreviewCanvas()` 不再是 CPU canvas，改为 GPU display surface。

3. **导出/截图 API**
   新增显式 `readbackExport()`；禁止在绘画中隐式 readback。

## 6. 色彩与精度处理

### 6.1 颜色空间

- Layer 与 scratch 在 **线性空间** 混合。
- Display 输出进行线性 → sRGB。

### 6.2 抖动（Dither）

在 `rgba16float → rgba8unorm` 写回时加入轻量抖动（Bayer 4x4 / 蓝噪）以减少 banding。

### 6.3 导出一致性（新增）

导出统一走：`linear -> sRGB8 + dither` 的 GPU pass，再 readback。
禁止从 `activeLayer` 直接 readback，以避免色彩路径不一致。

## 7. 里程碑与验收

### M0：设备能力探测 + 基线

- 探测 `maxTextureDimension2D`、格式支持、显存预算
- 8K/4K 分配与 clear/compose micro-benchmark

### M1：Tile 基础设施与显示

- tile 切分 + LRU 常驻
- 仅显示单层 tile 纹理

### M2：GPU 合成最小集

- normal + opacity + visibility
- `below/above` 可见 tile 缓存机制

### M3：GPU 笔刷写入 scratch + commit

- `GPUStrokeAccumulator` 直写 `rgba16float` tiles
- `commitStroke()` ping-pong/临时纹理方案

### M4：主要特性恢复

- dual / texture / wet-edge / scatter
- 回归一致性验证

### M5：Selection/Mask GPU 化 + 导出

- selection 纹理化
- 显式 readback（导出路径一致性）

## 8. 风险与对策

1. **色彩一致性偏差**
   - 对策：建立小画布像素对比基准，定义误差阈值

2. **显存压力 / tile 震荡**
   - 对策：LRU 预算上限 + 可见 tile 优先 + 统计 cache miss

3. **tile 失效条件遗漏**
   - 对策：显式枚举失效条件（可见性/opacity/blend/顺序/内容），并加测试用例

4. **兼容性**
   - 对策：保留 Canvas2D fallback，GPU 不可用自动切换

## 9. 验收用例（摘要）

- 8K 单层连续长笔画（30s），无停画/报错
- 4K 多特性组合与 Canvas2D 视觉对比
- 多层可见切换时仅重建受影响的 tile

## 10. 默认假设

- 单次仅对 active layer 绘画
- 32GB 显卡 8K，4060 笔记本 4K
- readback 仅用于导出/截图

## 11. 阶段任务清单（可执行）

### Phase 0：基线与风险收敛

- 8K WebGPU 纹理分配/clear/compose micro-benchmark（记录峰值显存与帧耗时）
- 明确 blend modes 目标清单与“视觉一致性”误差阈值
- 定义 `rgba8unorm` 线性存储 + sRGB 显示的转换规则与 dither 方案
- 明确 tile size（256/512）与 LRU 预算策略

### Phase 1：Tile 显示与最小合成

- 新增 GPU tile 显示层（替换 `LayerRenderer.composite()` 的实时路径）
- 实现 `GpuLayerStore` + `TileResidencyManager`
- 完成 `below/above` 可见 tile 缓存与刷新逻辑
- 验收：多层可见切换时仅重建对应 tile，绘画帧只做可见 tile 合成

### Phase 2：GPU 笔刷直写 + commit

- 改造 `GPUStrokeAccumulator` 输出到 `activeScratch (rgba16float)` tiles
- 实现 `commitStroke()`：`activeScratch + activeLayer -> activeLayerTmp (rgba8unorm)` 并 swap
- 引入抖动（Bayer 4x4 优先）
- 验收：8K 单层连续绘画稳定，无 readback

### Phase 3：特性恢复与一致性回归

- dual / texture / wet-edge / scatter 全路径 GPU 化
- 建立小画布像素对比基准（2K/4K）
- 验收：主要笔刷组合视觉一致，误差可控

### Phase 4：Selection/Mask 与导出

- selection 纹理化并纳入合成
- 明确导出/截图 readback 路径（仅在用户触发时执行）

### Phase 5：优化与可扩展性评估

- 优化 tile cache miss 与合成 pass 数量
- 对热点 shader 做性能优化（合成 pass 合并、减少采样次数）

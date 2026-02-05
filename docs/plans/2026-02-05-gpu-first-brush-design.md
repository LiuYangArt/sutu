# GPU-First 笔刷与渲染架构设计（8K 目标）

**日期**：2026-02-05  
**状态**：设计草案（已对齐）

## 1. 目标与成功标准

### 目标
- 面向 **8K 画布** 的低延迟高性能绘画。
- 彻底移除 **GPU→CPU readback + CPU 合成** 作为实时绘画路径。
- 保持“单层绘画”的交互习惯，同时正确显示上下层。
- 降低显存与带宽压力，避免 `maxBufferSize` / destroyed resource / preview stall。

### 成功标准
- 8K 单层绘画连续 30s：无停画、无 WebGPU ValidationError、输入延迟稳定。
- 4K 对比当前 Canvas2D 输出：误差可控（8-bit 误差 ≤ 1~2，且可解释）。
- 复杂笔刷组合（dual/texture/wet-edge/scatter）可用且稳定。

## 2. 非目标（本阶段不做）

- 不追求像素级完全一致（允许极小误差并可解释）。
- 不做多实例/网络协作画布。
- 不在实时绘画中执行任何 readback。

## 3. 核心决策

### 3.1 纹理格式策略（已定）
- **Layer 存储**：`rgba8unorm`（线性空间）
- **Active stroke scratch**：`rgba16float`
- **显示输出**：线性 → sRGB
- **导出/截图**：显式 readback，仅在需要时执行

理由：
`rgba32float` 在 8K 下显存/带宽不可接受；`rgba8unorm` 作为最终目标格式更合理，`rgba16float` 只在 active stroke 期间保障混合精度。

### 3.2 单层绘画 + 上下层显示
绘画只发生在 active layer，但需要正确显示上下层。因此引入缓存：
- `belowComposite`：active layer 之下所有层合成
- `aboveComposite`：active layer 之上所有层合成

缓存只在对应层集合发生变化时重建；绘画帧只进行有限次合成。

## 4. 架构概览

### 4.1 模块划分
1) **GpuLayerStore**  
维护每层 `GPUTexture (rgba8unorm)` 与可见性/opacity/blendMode 元数据。

2) **GpuLayerComposer**  
维护 `belowComposite`、`aboveComposite`、`display` 纹理；负责合成。

3) **GPUStrokeAccumulator（改造）**  
输出到 `activeScratch (rgba16float)`；`commitStroke()` 合成回 active layer。

4) **WebGPU Display**  
直接显示 `display` 纹理（不经 CPU Canvas2D）。

### 4.2 数据流
- 输入点 → `GPUStrokeAccumulator` 写入 `activeScratch`
- 每帧合成：`belowComposite + activeScratch + aboveComposite → display`
- 结束笔触：`activeScratch + activeLayer → activeLayer`（线性→sRGB + dither）
- 导出/截图：`display` 或 `activeLayer` 执行 readback（非实时）

## 5. 关键接口变化（Breaking）

1) **LayerRenderer.composite()**
 - 被 `GpuLayerComposer` 替代，Canvas2D 仅作为 fallback。

2) **Preview 路径**
 - `getPreviewCanvas()` 不再是 CPU canvas，改为 GPU display surface。

3) **导出/截图 API**
 - 新增显式 `readbackExport()`；禁止在绘画中隐式 readback。

## 6. 色彩与精度处理

### 6.1 颜色空间
- Layer 与 scratch 在**线性空间**混合
- Display 输出进行线性 → sRGB

### 6.2 抖动（Dither）
在 `rgba16float → rgba8unorm` 写回时加入轻量抖动（Bayer 4×4 / 蓝噪）以减少 banding。

## 7. 里程碑与验收

### M0：GPU 画布接管显示
- 仅显示单层 `rgba8unorm` 纹理
- 验收：8K 分配与刷新稳定

### M1：GPU 合成最小集
- normal + opacity + visibility
- below/above 缓存机制

### M2：GPU 笔刷写入 scratch
- `GPUStrokeAccumulator` 直写 `rgba16float`
- commit 合成回 `rgba8unorm` 层

### M3：主要特性恢复
- dual / texture / wet-edge / scatter
- 回归一致性验证

### M4：Selection/Mask GPU 化 + 导出
- selection 纹理化
- 显式 readback

## 8. 风险与对策

1) **色彩一致性偏差**
   - 对策：建立小画布像素对比基准，定义误差阈值

2) **显存压力**
   - 对策：限定常驻纹理数量（below/above/display/scratch + layer 纹理）

3) **兼容性**
   - 对策：保留 Canvas2D fallback，GPU 不可用自动切换

## 9. 验收用例（摘要）

- 8K 单层连续长笔画（30s），无停画/报错
- 4K 多特性组合与 Canvas2D 视觉对比
- 多层可见切换时 below/above 仅重建一次

## 10. 默认假设

- 单次仅对 active layer 绘画
- 8K 为目标上限
- readback 仅用于导出/截图

## 11. 阶段任务清单（可执行）

### Phase 0：基线与风险收敛
- 8K WebGPU 纹理分配/clear/compose micro-benchmark（记录峰值显存与帧耗时）
- 明确 blend modes 目标清单与“视觉一致性”误差阈值
- 定义 `rgba8unorm` 线性存储 + sRGB 显示的转换规则与 dither 方案

### Phase 1：GPU 显示与最小合成
- 新增 GPU 显示层（替换 `LayerRenderer.composite()` 的实时路径）
- 实现 `GpuLayerStore` 与最小 `GpuLayerComposer`
- 完成 `belowComposite` / `aboveComposite` 缓存与刷新逻辑
- 验收：多层可见切换时仅重建对应缓存，绘画帧只做 2-3 次合成

### Phase 2：GPU 笔刷直写 + commit
- 改造 `GPUStrokeAccumulator` 输出到 `activeScratch (rgba16float)`
- 实现 `commitStroke()`：`activeScratch + activeLayer → activeLayer (rgba8unorm)`
- 引入抖动（Bayer 4×4 优先）
- 验收：8K 单层连续绘画稳定，无 readback

### Phase 3：特性恢复与一致性回归
- dual / texture / wet-edge / scatter 全路径 GPU 化
- 建立小画布像素对比基准（2K/4K）
- 验收：主要笔刷组合视觉一致，误差可控

### Phase 4：Selection/Mask 与导出
- selection 纹理化并纳入合成
- 明确导出/截图 readback 路径（仅在用户触发时执行）

### Phase 5：优化与可扩展性评估
- 评估是否需要 tiled layer/atlas（B2 方向）
- 对热点 shader 做性能优化（合成 pass 合并、减少采样次数）

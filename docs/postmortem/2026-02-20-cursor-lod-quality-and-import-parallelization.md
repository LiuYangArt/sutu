# 2026-02-20 Cursor LOD 质量与导入性能并行化复盘

## 背景

在 ABR 导入 `liuyang_paintbrushes.abr` 的过程中，`scribbles 2` 与 `Sampled Brush #3 1` 暴露了两类问题：

1. LOD 形状失真：`LOD1/LOD2` 在部分复杂笔刷上出现“可识别性下降”或“退化为圆形”。
2. 导入耗时回升：引入多级 LOD 后，ABR 导入总耗时较旧链路明显增长。

目标是在不引入 Worker 改造的前提下，同时满足：

1. `LOD0/1/2` 视觉上保持“同一笔刷，仅细节递减”。
2. 导入耗时回落到可接受范围。

---

## 现象与证据

### 1. 形状侧

1. `scribbles 2` 早期 `LOD1` 过于稀疏，主体笔迹结构丢失明显。
2. `Sampled Brush #3 1` 早期 `LOD1` 一度退化到 `contourCount=1`，导致分支丢失。
3. `Sampled Brush #3 1` 的 `LOD2` 在预算失败时命中椭圆兜底，视觉变成“圆圈”。

### 2. 性能侧

1. 热点集中在导入阶段的 `build_preset_with_id -> from_abr_with_cursor_lod -> generate_cursor_lods`。
2. 导入链路最重阶段在 `cache` 段（包含纹理压缩缓存 + LOD 生成）。

---

## 根因

### 1. LOD 失真根因

1. `LOD1` 内部 `segment/contour` 预算过紧，先于 `pathLen` 触发，导致未吃满 `lod1PathLenLimit` 就发生形状裁剪。
2. `LOD2` 的最终兜底是外接框椭圆，一旦前序候选都不满足预算，会出现“形状突变”。

### 2. 性能回升根因

1. 每个 brush 的 LOD 生成原本串行执行，复杂 ABR 下 CPU 密集型步骤无法利用多核。
2. 导入循环中存在不必要的数据复制（例如 `tip.data.clone()`）放大了内存与压缩开销。
3. 计算型（`is_computed`）笔刷没有必要生成 sampled tip 的 cursor LOD，但早期链路仍会走同样流程。

---

## 关键改动

### 1. 质量侧（已落地）

1. 调整 `LOD1` 预算与候选策略，提升复杂笔刷保形能力，减少过早轮廓坍缩。
2. `LOD2` 新增“强制采样保形兜底”，优先尝试预算内保形结果，再退到椭圆。
3. 在 `generate_cursor_lods` 中增加跨 LOD 复用短路：高层已满足低层预算时直接复用，避免重复生成。

### 2. 性能侧（本次重点）

1. 导入流程并行化：
   1. 保持 ID 去重、pattern 关联修正为串行（保证行为稳定）。
   2. 将 `build_preset_with_id`（含 LOD 生成）切换为 `rayon::into_par_iter()` 并行。
2. 缓存写入并行化：
   1. 将 brush Gray8 压缩缓存写入迁移到并行构建阶段。
   2. 新增 `cache_brush_gray_ref`，消除 `tip.data.clone()`。
3. 无效工作剪枝：
   1. `is_computed` 笔刷跳过 cursor LOD 生成。

---

## 结果

### 1. 形状结果（代表样本）

1. `Sampled Brush #3 1`：
   1. `LOD1` 从“轮廓显著丢失”提升到可识别分支结构。
   2. `LOD2` 不再稳定落入圆形兜底（示例复杂度：`pathLen=3127, segment=206, contour=6`）。
2. `scribbles 2`：
   1. `LOD1` 复杂度提升（更接近预算上限），保形显著改善。

### 2. 性能结果（同机同包）

`liuyang_paintbrushes.abr` 导入 benchmark：

1. 单线程对照（`RAYON_NUM_THREADS=1`）：
   1. `total_ms=3620.89`
   2. `cache_ms=3460.74`
2. 默认并行：
   1. `total_ms=2002.19`
   2. `cache_ms=1847.02`
3. 并行化净收益：
   1. 总耗时下降约 `44.7%`
   2. 约 `1.81x` 加速

---

## 经验沉淀

1. `pathLen` 阈值只是外层预算，真实保形常常先被 `segment/contour` 内部预算决定。
2. LOD 最后兜底若是几何原语（ellipse），在有机形状笔刷上会造成突兀视觉断层；应优先使用“保形但降采样”的兜底。
3. 导入链路优化应优先识别 CPU 密集区并并行化，而不是先做细粒度微优化。
4. 并行化时保持“顺序敏感步骤串行、纯计算步骤并行”是低风险策略。
5. 移除大对象 clone（例如像素 buffer）对并行场景收益明显，且稳定性高。

---

## 后续优化建议

1. 增加导入并行度上限配置（自动按 CPU 核心或用户配置限制）。
2. 将 LOD 质量指标（IoU/Dice 或轮廓覆盖率）接入离线回归脚本，避免后续改动回退。
3. 对超复杂 brush 增加“快速预判 -> 直接走复用/降级路径”，进一步降低尾部耗时。

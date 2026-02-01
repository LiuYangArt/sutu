# ABR 笔刷顺序与缺失笔刷修复 Postmortem

**日期**: 2026-01-31
**作者**: @Antigravity
**状态**: 已解决

## 问题描述

用户反馈导入 ABR 笔刷文件 (`liuyang_paintbrushes.abr`) 后，PaintBoard 中的笔刷顺序与 Photoshop 中显示的顺序不一致。此外，部分笔刷（特别是 Photoshop 自带的 Soft Round/Hard Round 等标准笔刷）在 PaintBoard 中完全缺失。

初步统计：

- Photoshop 显示: 79 个笔刷
- PaintBoard 解析: 71 个笔刷
- 缺失: 8 个笔刷
- 顺序: 混乱，与 PS 不符

## 根因分析

通过 `analyze_brush_order.rs` 和 `analyze_brush_params.rs` 对 ABR 文件结构进行深度分析，发现：

1.  **物理顺序 vs 逻辑顺序**:
    - ABR 文件的 `samp` (Sampled Data) section 存储了包含位图数据的笔刷，其顺序是物理存储顺序。
    - `desc` (Descriptor) section 包含一个 `Brsh` 列表，这才是 Photoshop 用来显示笔刷的**权威逻辑顺序**。
    - 原解析器 (`AbrParser::parse_v6`) 仅仅遍历 `samp` section，导致按物理存储顺序加载，忽略了逻辑顺序。

2.  **Computed Brushes 缺失**:
    - 缺失的 8 个笔刷（如 `Soft Round 500 1`, `Hard Round 100`）在 `desc` 列表中存在，但没有对应的 sampled data (UUID)。
    - 这些是 "Computed" 或 "Procedural" 笔刷，它们不依赖预渲染的位图，而是通过参数（直径、硬度、圆度、角度）实时生成。
    - 原解析器因为只看 `samp` section，自然忽略了这些没有采样数据的笔刷。

## 解决方案

我们重构了 `AbrParser` 的核心逻辑，采用了 **Descriptor-First** 的策略：

1.  **分步解析**:
    - **Step 1 解析样本**: 先遍历 `samp` section，但不立即生成 Brush 对象，而是将所有样本数据（图像、UUID等）存入 `HashMap<UUID, SampBrushData>`。
    - **Step 2 权威排序**: 遍历 `desc` section 的 `Brsh` 列表，以此为顺序基准构建最终的笔刷列表。

2.  **双模式构建**:
    - 对于列表中的每个 Descriptor，检查是否有 `sampledData` UUID。
    - **Sampled Brush**: 如果有 UUID，从 Step 1 的 HashMap 中取出对应的位图数据。
    - **Computed Brush**: 如果没有 UUID，判定为计算型笔刷。提取 `Dmtr` (直径), `Hrdn` (硬度), `Rndn` (圆度), `Angl` (角度) 等参数。

3.  **SDF 图像生成**:
    - 为 Computed Brush 实现了一个基于 **SDF (Signed Distance Field)** 的图像生成算法 `generate_computed_tip`。
    - 该算法能根据参数动态生成高质量、抗锯齿的圆形/椭圆形笔刷缩略图，确保 UI 上所有笔刷都有预览。

## 验证结果

运行验证脚本 `verify_brush_order_fix.rs` 确认：

- **数量匹配**: 成功解析出 79 个笔刷（之前 71 个）。
- **顺序一致**: 笔刷顺序与 Photoshop 完全吻合。
- **功能完整**: 缺失的 Computed Brushes 均已找回，并拥有正确的自动生成缩略图。

## 经验教训 (Lessons Learned)

1.  **不要假设文件物理顺序**: 在处理复杂格式（如 PSD/ABR/AI）时，物理存储顺序往往是为了优化读取或历史遗留，而元数据（Descriptor/Metadata）才是逻辑显示的真理。
2.  **缺失数据往往是另一类数据**: 当发现部分数据“丢失”时，往往是因为它们属于另一种无需存储实体数据（如纯参数化）的类型。
3.  **工具辅助分析**: 编写专门的分析脚本（如 `analyze_brush_structure`）比盲目猜测代码逻辑高效得多。

## 后续修复: React Duplicate Key 警告

在验证 UI 时发现控制台报告 `Warning: Encountered two children with the same key`。

**原因**: 某些 ABR 笔刷共享相同的 UUID（例如 `Oil Pastel Large #41/36/45` 均源自同一基础模板）。在 `BrushPresets.tsx` 中直接使用 `preset.id`（即 UUID）作为 React key 导致冲突。

**修复**: 改用 `${preset.id}-${index}` 作为复合 key，保证唯一性。

```diff
- {importedPresets.map((preset) => (
-   <button key={preset.id} ...>
+ {importedPresets.map((preset, index) => (
+   <button key={`${preset.id}-${index}`} ...>
```

## 相关工件

- `src-tauri/src/abr/parser.rs`: 核心解析逻辑重构
- `src-tauri/examples/verify_brush_order_fix.rs`: 自动化验证脚本
- `src/components/BrushPanel/settings/BrushPresets.tsx`: React key 修复

# ABR 导入：Dual Brush 对齐与 tip-only 补齐（以 “Sampled Brush 5 4” 验收）

## 背景

目标是让 ABR 导入的 Dual Brush 能与 Photoshop 的 Dual Brush 面板数值与行为对齐，并能正确显示/选择副笔刷 tip。

验收文件：`abr/liuyang_paintbrushes.abr`  
验收笔刷：**“Sampled Brush 5 4”**

## 现象（导入前）

1. **主笔刷 Size 不对**  
   - PS：主 Size ≈ 600  
   - PaintBoard：主 Size ≈ 138  
   - 导致 Dual Brush sizeRatio 虽然“比例正确”（≈1.01），但 dual size 被同步到 ≈139，而不是 PS 的 606。

2. **Secondary tip 看起来缺失**  
   Dual Brush 面板里无法看到/选中 PS 中显示的 secondary tip（例如 “Sampled Brush #114”）。

3. **Dual Brush 参数未完全导入/未自动开启（早期阶段）**  
   包括开关、Count、Scatter 等字段读取不到而落回默认值。

## 根因

### 1) 主 Size 导入取了 samp bitmap 宽度，而不是 preset 存档尺寸

sampled brush 的 `samp` 里包含 tip 的像素数据，其 bitmap 宽度可能只有 ≈138；但 Photoshop 的 preset 里会在 `Brsh.Dmtr(#Pxl)` 保存“笔刷尺寸”（例如 600）。

PaintBoard 初始实现只用 `samp` 的宽度作为 `brush.diameter`，而 `apply_brush_tip_params()` 没有处理 `Dmtr` 覆盖，导致主 Size 永久偏小，进而影响 dual size（按 ratio 同步）。

### 2) Dual Brush 字段存在“嵌套存储 + 类型差异”

在该 ABR 的 Dual Brush 描述符结构中：

- Dual Brush 开关：`dualBrush.useDualBrush`（嵌套在 `dualBrush` 描述符内，不在根级）
- Count：`Cnt ` 可能是 `doub`（Double）
- Scatter：该文件实际用 `dualBrush.scatterDynamics.jitter(#Prc)` 表示 scatter，而不是传统 `Sctr/Scat`

如果解析器只匹配根级字段或只支持 UnitFloat/Integer，会导致这些参数回退默认值。

### 3) Secondary tip 可能是“tip-only”（只有 samp 资源，没有独立 preset 条目）

PS 的 secondary tip（例如 “Sampled Brush #114”，UUID=`0fd938d3-665f-11d8-8a89-d1468c4d447d`）在 ABR 里很可能只存在于 `samp`（像素资源），但在 `desc` 的 brush preset 列表中没有独立条目。

之前前端 Dual Brush 的列表复用 `presets`，因此 tip-only 无法出现在选择列表中。

## 解决方案（已实施）

### 1) 主尺寸修正：支持 `Brsh.Dmtr` 覆盖 sampled 初始值

- 在 `apply_brush_tip_params()` 中读取 `Dmtr(#Pxl)` 并覆盖 `brush.diameter`。
- 结果：主 Size 从 bitmap 宽度（≈138）变为 preset 存档值（≈600），dual size 也随 ratio 自动变为 ≈606。

### 2) Dual Brush 解析补齐：嵌套 useDualBrush + Count(Double) + Scatter(jitter)

- `create_brush_from_descriptor_entry()`：启用判断同时支持根级与 `dualBrush.useDualBrush`。
- `parse_dual_brush_settings()`：Count 用通用数值读取；Scatter 优先兼容 `Sctr/Scat`，缺失时回退到 `scatterDynamics.jitter`。

### 3) tip-only 资源补齐：只进入 Dual Brush tip 列表，不污染主 Presets

后端解析层（V6+）：
- 扫描所有 brush 的 `dual_brush_settings.brush_id`
- 若引用的 UUID 不在 preset brush 列表，但在 `samp_map` 中存在，则生成 `is_tip_only=true` 的 `AbrBrush` 追加到 brushes

后端返回层：
- `ImportAbrResult` 新增 `tips`
  - `presets`：仅包含 `!is_tip_only`
  - `tips`：包含全部 brushes（含 tip-only）

前端：
- BrushPanel 增加 `importedTips` state
- Dual Brush 面板渲染 `importedTips`（而主 Brushes tab 仍渲染 `importedPresets`）
- 为了把 ABR 的 UUID 引用映射到 PaintBoard 的缓存 id：
  - `BrushPreset` 新增 `sourceUuid`
  - 应用 preset 时 secondary 查找使用 `id === brushId || sourceUuid === brushId`
  - 将 `dualBrush.brushId` 统一设置为“可缓存的实际 id”（而不是 ABR UUID），保证能加载纹理

## 结果（导入后验收）

以 “Sampled Brush 5 4” 为准：
- 主 Brush Tip Shape Size：≈600px
- Dual Brush Size：≈606px（≈101%）
- Dual Brush 参数：Mode=Darken、Spacing≈99%、Scatter≈206%、Count=5
- Secondary tip：可在 Dual Brush 列表中看到并选中 “Sampled Brush #114”，且不会出现在主 Brushes(Presets) 列表

## 经验总结

1. **sampled brush 的“像素分辨率”不等于“preset 尺寸”**：`samp` 仅提供 tip 图；`Brsh.Dmtr` 才是 PS 语义上的 size。
2. **ABR 的 descriptor 字段存在变体与类型漂移**：同一概念（如 scatter/count）可能以不同 key 或不同类型存储，解析要有兼容链路与回退策略。
3. **tip-only 资源要与主 preset 列表解耦**：Dual Brush 选择列表应基于“可用 tip 集合”，而不是“可见 preset 集合”。
4. **区分 ABR UUID 与运行时缓存 id**：保留 `sourceUuid` 用于链接，同时把运行期 `brushId` 绑定到可加载纹理的缓存 id，避免 UI/渲染链路断裂。


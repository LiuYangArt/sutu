# ABR Computed 圆头 Dual Brush 抗锯齿未生效复盘

## 问题背景

用户反馈：Dual Brush 使用 ABR 导入的“procedural 圆头”时，边缘锯齿明显；而默认 procedural 圆头效果正常。  
此前已对 CPU 笔刷 AA 做了优化（椭圆真实边界距离 + 子像素采样），但该问题仍存在。

## 现象

- Dual Brush 选择 ABR 导入的“圆头”（缩略图类型）时，边缘仍是硬锯齿。
- 同一设置下，默认 procedural 圆头 AA 正常。

## 根因分析

1. **ABR computed 圆头被误判为纹理笔刷**
   - ABR 解析中 computed brush 会生成 `tip_image`（灰度图）。
   - 构建 `BrushPreset` 时使用 `tip_image.is_some()` 判定 `has_texture = true`。
   - Dual Brush 选择该圆头时走 `TextureMaskCache` 路径，而不是 procedural `MaskCache`。

2. **computed tip 生成是硬边，无 AA**
   - `generate_computed_tip()` 在 `hardness = 1.0` 时生成硬边灰度图，无 1px 过渡。
   - 即使 `TextureMaskCache` 做子像素采样，源 tip 仍是硬边 → 结果依旧锯齿。

## 修复方案

- **将 ABR computed 圆头标记为 procedural**
  - `has_texture = brush.tip_image.is_some() && !brush.is_computed`
  - computed brush 不缓存 tip 图，避免纹理路径。
  - 让 Dual Brush 走与默认 procedural 相同的 AA 逻辑。

## 结果

- ABR 导入的“procedural 圆头”在 Dual Brush 下 AA 恢复正常。
- 纹理类 sampled brush 仍保持原路径与行为不变。

## 经验总结

1. **是否走纹理路径不应只看 tip_image 是否存在**，还要区分 computed vs sampled。
2. **硬边 tip 无法通过采样弥补 AA**，需要从源图或路径选择上修正。
3. **当“同类外观”产生不同路径时，应优先追踪渲染分支而非单点优化。**

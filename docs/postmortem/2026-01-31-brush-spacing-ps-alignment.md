# Photoshop Spacing 对齐修复总结

## 问题背景

用户在对比 Photoshop 时发现以下偏差：

1. 扁平刷、低 roundness 笔刷 spacing 明显偏稀。
2. Spacing 范围只有 0–100%，而 PS 为 0–1000%。
3. Shape Dynamics 的 Size 控制与工具栏“压感大小”在 spacing 上表现不一致。
4. Dual Brush 中一些椭圆（roundness ≠ 100）tip 的 spacing 不正确。

## 根因分析

1. spacing 仍按 `size`（长边/直径）计算，忽略 tip 真实宽高，导致扁平刷过稀。
2. 纹理 tip 在 roundness < 100 时直接按 `size * roundness` 计算高度，丢失原始宽高比。
3. spacing 仅受“压感大小”影响，Shape Dynamics 的 size control 未纳入；jitter 也不应影响 spacing。
4. Dual Brush 生成次级 mask 时 roundness 固定为 1，且次级 dabs 仅在 texture 有 imageData 时生成，导致椭圆 tip 的 spacing 和形状偏差。

## 修复方案

1. **spacing 以 tip 短边为基准**
   - 计算 tip 实际尺寸（纹理长宽比 + roundness）。
   - `spacingPx = spacingPercent * min(width, height)`。

2. **纹理 tip 缩放顺序修正**
   - 先按原始长宽比缩放到 `size`。
   - 再应用 roundness 纵向压缩。

3. **Shape Dynamics size control 影响 spacing**
   - spacing 使用 `size control + minimum` 的结果。
   - jitter 不影响 spacing（符合 PS 预期）。

4. **Dual Brush roundness 同步**
   - 预设选择时记录 roundness。
   - 次级 spacing 计算与 mask 生成均使用 roundness。
   - 取消 “imageData 必须存在才生成次级 dabs” 的限制（非纹理椭圆也要工作）。

5. **Spacing UI 范围对齐**
   - UI 允许 1–1000%（内部 0.01–10.0）。

## 关键实现点

- `src/components/Canvas/useBrushRenderer.ts`
  - 统一计算 `spacingBasePx`，并引入 `computeControlledSize`。
  - Dual Brush spacing 基于 roundness + 纹理信息计算。
- `src/utils/textureMaskCache.ts`
  - 先保持纹理长宽比，再应用 roundness。
- `src/utils/strokeBuffer.ts`
  - `BrushStamper` 接收 `spacingPx`。
  - Dual Brush 的次级 mask 使用 roundness。
- `src/stores/tool.ts`
  - spacing 范围改为 0–10。
  - Dual Brush 增加 `roundness` 字段。
- `src/components/BrushPanel/settings/BrushTipShape.tsx`
  - Spacing UI 上限改为 1000%。
- `src/components/BrushPanel/settings/DualBrushSettings.tsx`
  - 继承 preset roundness。
  - Spacing UI 上限改为 1000%。

## 验证结果

- 30×60 笔刷，spacing=50% → 间距 15px（与 PS 一致）。
- angle 不影响 spacing；roundness 影响 spacing 基准（符合 PS）。
- Shape Dynamics size control 与工具栏压感大小在 spacing 上一致。
- Dual Brush 椭圆 tip spacing 正确。

## 经验总结

1. **PS spacing 的语义是 tip 短边**，而非 size/直径。
2. **纹理 roundness 必须在保留原始长宽比之后应用**，否则形状与 spacing 均失真。
3. **spacing 仅跟 size control 相关，不受 jitter 影响**，否则用户感知会不稳定。
4. Dual Brush 必须保留 tip 元数据（roundness/ratio），否则 spacing 很难对齐 PS。

# Photoshop Scatter 对齐修复总结

## 问题背景

用户对比 Photoshop 后发现散布幅度偏大：

1. 我们 scatter=100 的范围明显大于 PS 的 100。
2. 我们 scatter=50 ≈ PS scatter=100。
3. 我们 scatter=100 ≈ PS scatter=200。
4. Dual Brush 的 scatter 与主笔刷算法不一致。

## 根因分析

1. 散布幅度按直径计算，等效放大了一倍（PS 语义更接近半径）。
2. Dual Brush 使用独立随机散布逻辑，且默认双轴散布，导致与主笔刷不一致。

## 修复方案

1. **散布幅度与 PS 对齐**
   - 散布量改为基于半径：`scatterAmount = (scatter% * diameter * 0.5)`。
2. **Dual Brush 统一使用散布算法**
   - Dual Brush 直接复用 `applyScatter`。
   - 传入次级笔触方向以支持单轴散布逻辑。

## 关键实现点

- `src/utils/scatterDynamics.ts`
  - 散布量按半径缩放（`* 0.5`）。
- `src/utils/strokeBuffer.ts`
  - Dual Brush 改用 `applyScatter` 生成散布位置。
- `src/components/Canvas/useBrushRenderer.ts`
  - 为次级笔刷计算路径方向并传给 Dual Brush。

## 验证结果

- scatter=50 的扩散范围 ≈ PS scatter=100。
- scatter=100 的扩散范围 ≈ PS scatter=200。
- Dual Brush 散布方向与主笔刷一致（单轴/双轴行为一致）。

## 经验总结

1. **PS 的 Scatter 语义更接近“半径比例”**，不能直接用直径放大。
2. **主/副笔刷的散布必须共享同一算法**，否则视觉对齐会出现系统性偏差。

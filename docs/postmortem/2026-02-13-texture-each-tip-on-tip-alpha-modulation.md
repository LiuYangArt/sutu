# Texture Each Tip=On 深度不足纠偏复盘（2026-02-13）

**日期**：2026-02-13  
**状态**：已修复并完成自动化回归

## 背景

在 `Texture Each Tip=On` + `Darken` 场景下，PaintBoard 与 Photoshop 对比时整体偏浅。  
现象是：我们能看到纹理变化，但“每 dab 的压暗感”不够，导致整笔不够厚重。

## 关键现象

1. `Each Tip=On` 时，PS 明显更深，且 dab 叠加感更强。
2. 旧实现里 ON 虽然更深于 OFF，但仍显著弱于 PS。
3. `Depth Jitter` 能变化，但不影响“整体偏浅”的主问题。

## 根因

`Each Tip=On` 路径把纹理影响施加在了 **Alpha Darken ceiling**（`dabOpacity`）上，而不是施加在 **tip alpha（mask）** 上。  
这会使每个 dab 的可积累空间被提前收缩，导致深度增长被抑制，最终视觉偏浅。

## 修复

统一 CPU/GPU 语义为：

1. `Texture Each Tip=On`：纹理调制 tip alpha（`mask`），不调制 `ceiling`。
2. `calculateTextureInfluence` 在 Each Tip 路径传入 `accumulatedAlpha=0`，避免把连续笔画语义混入 per-tip 计算。
3. `ceiling` 保持 `dabOpacity`（再叠加 dual brush 对 opacity 的影响）。

涉及文件：

1. `src/gpu/shaders/computeBrush.wgsl`
2. `src/gpu/shaders/computeTextureBrush.wgsl`
3. `src/utils/maskCache.ts`
4. `src/utils/textureMaskCache.ts`

## 验证

1. `pnpm -s typecheck` 通过。
2. `pnpm -s test -- textureMaskCache textureDynamics useBrushRendererTextureEachTip textureRendering` 通过。
3. 视觉对照：`Each Tip=On` 的压暗趋势与 PS 更接近，`On/Off` 差异更符合预期。

## 经验沉淀

1. `Each Tip` 的核心是“每 dab 的 tip alpha 语义”，不是“每 dab 的 ceiling 语义”。
2. 非线性纹理模式中，`mask` 与 `ceiling` 的调制位置会直接改变累积曲线。
3. CPU/GPU 必须同位修复，否则会出现“单链路正确、整体仍漂移”。
4. 对齐 PS 时，先保证作用点一致，再谈参数微调。

# Texture Each Tip=Off 对齐修复复盘（2026-02-13）

**日期**：2026-02-13  
**状态**：已修复并完成基础回归

## 背景

在 `Texture Each Tip` 关闭时，`Darken / Color Burn / Linear Burn` 仍表现出明显 dab 感，与 Photoshop 的连续纹理效果不一致。  
用户验证表明：PS 更接近“先形成连续 stroke alpha，再应用 texture blend”。

## 根因

1. 渲染链路中 `textureEachTip` 只参与 depth 变体控制，没有真正控制混合语义。  
2. 纹理混合仍在每个 dab 循环内执行，导致非线性模式被 dab mask 形状放大。  
3. `darken/color burn/linear burn` 对低 alpha 区域高度敏感，逐 dab 计算会强化 spacing 痕迹。

## 修复方案

实现语义分流：

1. `textureEachTip=true`：保留 per-dab 纹理混合（旧行为）。  
2. `textureEachTip=false`：改为 stroke-level 纹理混合（整笔累积后按像素调制 alpha）。

落实位置：

1. GPU：新增 uniform `pattern_each_tip`，在 WGSL 中按开关切换 per-dab / stroke-level。  
2. CPU fallback：关闭 `textureEachTip` 时跳过每 dab 调制，在 `syncPendingToCanvas` 阶段做整笔调制。  
3. Pattern settings 结构补齐 `textureEachTip` 字段并纳入变更检测。

## 验证

1. `pnpm -s typecheck` 通过。  
2. `pnpm -s test -- textureRendering textureMaskCache maskCache.softnessProfile` 通过（15/15）。  
3. 手测：`Texture Each Tip` 关闭时，`Darken / Color Burn / Linear Burn` 串珠感显著下降，视觉连续性接近 Photoshop。

## 经验沉淀

1. `Texture Each Tip` 是“混合作用域开关”，不能只做为 depth 抖动控制项。  
2. 非线性模式下，逐 dab 与逐 stroke 的顺序差异会被显著放大。  
3. 对齐 Photoshop 时，先对齐“作用域与顺序”，再微调公式。

# Postmortem: Texture Blend Mode 回归（改错作用点导致纹理被“填平”）

**日期**: 2026-02-04  
**状态**: 已修复（CPU/GPU 对齐）

## 背景

Texture 模式的语义是：

- `tip alpha`（笔刷形状/硬度产生的 mask）与 `pattern texture`（彩色需先转灰度）做 blend mode；
- blend 后的结果用于 **调制笔刷最终的不透明度上限（Alpha Darken 的 ceiling / headroom）**；
- 纹理是“密度/天花板”的调制，而不是“喷涂速率/flow”的调制。

## 现象

- 在某次重构后，`Multiply` 等原本接近 Photoshop 的 Texture 模式变得明显不对：
  - opacity=100% 时纹理几乎看不到（像被抹平/填满）。
  - opacity 降低后才隐约看到纹理（更像 flow 被调制，而不是最终覆盖度被调制）。
- 对比 PS：同一组 pattern / scale / invert / depth 参数下差异显著。

## 根因

### 1) Texture 被错误地实现为“改写 tip alpha（srcAlpha/flow）”

Alpha Darken 的核心是：

- `srcAlpha` 决定“本次 dab 抬高 dst alpha 的速度”
- `ceiling` 决定“本次 dab 最终最多能把 dst alpha 抬到哪”

当 Texture 的 blend 作用在 `srcAlpha` 上，而 `ceiling` 仍为 `dabOpacity`（通常接近 1）时：

- 多次叠加/连续 dab 会把 dst alpha 逐步推向同一个 ceiling；
- 纹理只是在改变“趋近速度”，并不会改变最终能到达的覆盖上限；
- 最终视觉上就是“纹理被填平”，尤其在 opacity=100% 时最明显。

### 2) 纹理应调制 ceiling（最终覆盖上限），而不是调制 flow

PS 的 Texture 更像“密度贴图”：同样的 build-up/叠加条件下，纹理仍然作为每像素不同的最大覆盖度存在。

## 修复方案（CPU/GPU 一致）

把 Texture 的 blend 结果从“直接输出修改后的 tip alpha”改为 **输出 multiplier，用于调制 ceiling**：

1. `base = tipAlpha`（0..1）
2. `blend = patternGray`（0..1，RGB 用 `0.299/0.587/0.114` 转灰度；再应用 invert/brightness/contrast）
3. `blended = BlendMode(base, blend)`
4. `target = mix(base, blended, depth01)`
5. `multiplier = (base > eps) ? (target / base) : 0`
6. `ceiling = dabOpacity * multiplier * (dualBrushOpacityMod...)`
7. `srcAlpha = (maskAfterNoise) * flow`（Noise 仍只影响 mask/srcAlpha，不影响 ceiling）

对 `Multiply`：

- `blended = base * blend`
- `target/base = blend`
- `ceiling = dabOpacity * blend`

这会让纹理稳定地表现为“最终覆盖度上限”的贴图，不会被叠加填平。

## 验证方式

- 选择 Texture 模式，设定与 PS 同样的：
  - `Scale / Brightness / Contrast / Invert / Depth`
  - `Mode=Multiply/Darken/Linear Burn...`
- opacity=100% 连续涂抹/叠加：
  - 纹理应保持可见（不会逐步消失）
- opacity 降低时：
  - 纹理对“覆盖上限”的调制仍应成立（只是整体 ceiling 更低）

## 经验总结（可复用）

1) **AlphaDarken 里要严格区分 flow(srcAlpha) 与 ceiling(opacity headroom)**：Texture / Dual Brush 这类“密度/纹理”效果应调制 `ceiling`；Noise/WetEdge 这类“边缘扰动”更适合调制 `srcAlpha`。  
2) **build-up/叠加是放大镜**：如果一个效果在 100% opacity 下会被“填平”，通常是把该效果放错了作用点（flow vs ceiling）。  
3) **CPU/GPU 必须公式级对齐**：调参/对齐 PS 时，任何“CPU 一套、GPU 一套近似”都会导致收敛失败。


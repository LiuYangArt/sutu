# Postmortem: Texture Overlay 在低 Opacity 下与 PS 不一致（Opacity 作用顺序错误）

**日期**: 2026-02-05  
**状态**: 已修复（CPU/GPU 预览与最终合成一致）

## 背景

在笔刷 `Texture` 面板中，`Mode=Overlay`（以及其它非线性 blend mode）需要与 Photoshop 的结果对齐。

本项目的笔刷渲染管线采用 Flow/Opacity 分离的三层结构：

- **Flow**：每个 dab 的累积速率（stroke 内 build-up）
- **Opacity**：stroke 最终合成到图层时的整体上限（ceiling / post-multiply）

Texture 的语义（见 `docs/postmortem/2026-02-04-texture-blend-mode-ceiling-regression.md`）是：Texture 调制 **Alpha Darken 的 ceiling**，而不是调制 flow。

## 现象

- `Opacity=100%` 时：我们的 Overlay 纹理效果与 PS 视觉上基本一致。
- `Opacity` 降低（例如 50%）时：PS 的笔触中心区域几乎没有纹理，但我们的中心仍残留明显纹理。
- 反证实验：在我们这里先用 `Opacity=100%` 画，再把**图层 opacity** 调到 50%，结果反而更接近 PS。

## 根因

我们把“笔刷 Opacity”错误地**烘进了每个 dab 的不透明度上限**（`dabOpacity` / ceiling），导致 Texture Overlay 的非线性混合发生在“低 ceiling”的空间里。

这会带来一个关键差异：

- **PS 更接近**：先按满强度计算 Texture（叠加与饱和按真实 headroom 发生），最后在 stroke 合成到图层时整体乘以 Opacity。
- **我们旧实现**：在每个 dab 阶段就把 ceiling 降低，再做 overlay/非线性混合；中心区域不再先饱和到 1，导致低 opacity 下仍残留纹理结构。

因此你看到的“先 100% 画、再降图层 opacity 才对”的现象，本质上就是**后乘（post-multiply）**与**前乘（bake into dab）**在非线性混合下不交换。

## 修复方案

把“笔刷 Opacity”恢复为真正的 **stroke-level** 参数：

1. **dab 阶段**只计算相对倍率（per-dab multiplier），不要把 base opacity 烘进 `dabOpacity`。
2. **合成阶段**（`endStroke/compositeToLayer`）再把 stroke buffer 整体乘以 `strokeOpacity`，确保预览与最终一致。

具体实现要点：

- `useBrushRenderer` 在 `processPoint` 中缓存 `strokeOpacity`，但 dabs 使用 `dabOpacity` 作为“相对倍数”（默认 1.0）。
- `endStroke`（CPU）与 `compositeToLayer`（GPU）使用该 `strokeOpacity` 进行最终合成。
- 预览插入（layer renderer preview overlay）也使用同一个 `strokeOpacity`，保持 WYSIWYG。

## 验证方式

- 选择 PS 同参数的 Texture Overlay 笔刷：
  - `Depth/Scale/Brightness/Contrast/Invert` 一致
  - `Opacity=50%`（或更低）
- 对比：
  - 旧实现：中心纹理残留明显
  - 新实现：中心趋于“纯色/无纹理”，纹理主要体现在边缘/半透明区域（与 PS 更一致）
- 反证实验仍成立：`Opacity=100%` 绘制后再降图层 opacity，结果与直接 `Opacity=50%` 更接近同一逻辑（说明 opacity 的作用点已对齐）。

## 经验总结（可复用）

1. **非线性 blend mode 下，乘法顺序不可交换**：Opacity 若被提前烘进 dab/ceiling，会改变 overlay 这类模式的最终形态。
2. **区分三个作用点**：
   - `flow/srcAlpha`：累积速率
   - `texture/dual ceiling multiplier`：像素级覆盖上限的调制
   - `stroke opacity`：合成阶段整体 post-multiply
3. **对齐 PS 时优先做“结构对齐”**：先保证作用点与顺序一致，再讨论参数拟合；否则调参永远收敛不了。


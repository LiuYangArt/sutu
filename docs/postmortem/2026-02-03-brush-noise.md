# 2026-02-03 Brush Noise 实现复盘 (Postmortem)

**日期**: 2026-02-03  
**状态**: 已完成

## 背景

目标是实现 Photoshop 笔刷面板里的 **Noise**：让笔触边缘产生颗粒噪点，使笔触更自然，并且在 CPU 与 GPU（compute shader）路径保持 WYSIWYG 一致。

## 现象与对比

1. **初版实现的噪点污染了笔刷中心区域**：即使 tip alpha 接近 1 的中心，也会出现明显“打孔/颗粒”。
2. 与 PS 对比发现：PS 的 Noise **主要只作用于软边区域**（tip alpha != 1 的过渡带），中心基本不受影响。
3. 在 Substance Designer 的验证中，噪声与 alpha 的混合更接近 **overlay**，并用于影响最终的笔刷不透明度（tip alpha）。

## 根因

### 1) 误把 Noise 当作 Texture ceiling modulation

最初按 Texture 的思路实现：把 Noise 作为一种 pattern，参与“ceiling multiplier”计算（类似 multiply/subtract），这等价于在整个 dab 的不透明度上施加噪声。

这会导致：
- alpha=1 的中心也被噪声影响（尤其在 subtract/偏黑噪声时变得明显）
- 视觉上与 PS “只扰动边缘”不符

### 2) 噪声分布不符合 overlay 的中性假设

overlay 的“中性值”在 0.5：当噪声以 0.5 为中心时，overlay 不会系统性变亮/变暗。

早期用偏黑（例如 `pow(rand(), k)`）分布会把整体往“减少 alpha”的方向推，进一步放大中心被影响的问题。

## 最终方案（CPU 与 GPU 一致）

### 1) Noise 作用在 tip alpha 上（不是 ceiling multiplier）

对每个像素的 `maskValue`（tip alpha）做：

1. **仅在软边区域启用**：`0 < maskValue < 1`（用阈值避免边界误差）
2. 采样噪声 `noiseVal`（canvas space / 绝对像素坐标，固定可重复）
3. 计算 `overlay(maskValue, noiseVal)`
4. 用强度做线性插值：`maskValue = mix(maskValue, overlayResult, strength)`

这样：
- 中心（maskValue≈1）不会被扰动
- 软边（maskValue<1）会出现颗粒化过渡，贴近 PS

### 2) 噪声纹理改为以 0.5 为中心的高斯噪声

把噪声纹理的分布从偏黑改为近似高斯（均值 0.5），以符合 overlay 的中性假设，避免整体偏移。

### 3) GPU compute shader 路径独立绑定 noise texture + uniforms

GPU 的 pattern/texture modulation 仍然用于 Texture 功能；Noise 是**独立的**：
- 增加 `noise_texture` binding
- uniforms 中传入 `noise_enabled / noise_strength`
- 在 compute 内对 mask 做 overlay（与 CPU 相同 gating）

## UI 经验

Noise 的开关应该与 Wet Edges / Build-up 一致放在左侧列表（sidebar checkbox），而不是放在 tab 内容区域里，避免重复入口与交互不一致。

## 经验总结（可复用的判断准则）

1. **先确定“作用点”**：是影响 tip alpha（mask），还是影响 ceiling（opacity headroom），两者视觉差异极大。
2. **overlay 的中性值是 0.5**：噪声分布以 0.5 为中心才能“扰动而不偏移”。
3. **PS 行为经常是“只影响软边”**：很多效果（Noise/WetEdge 等）本质上利用了 tip 的 alpha 梯度。
4. **CPU/GPU WYSIWYG 要从公式层统一**：不要“CPU 复用一套逻辑、GPU 走另一套近似”，否则调参无法收敛。

## 后续行动（可选）

- [ ] 将 Noise 同步到 GPU render pipeline fallback（非 compute）路径，保证所有 GPU 渲染路径一致
- [ ] 增加一个渲染级回归用例：对比 noiseEnabled on/off 的边缘差异（允许阈值）


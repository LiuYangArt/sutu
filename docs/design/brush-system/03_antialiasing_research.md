# Krita 笔刷抗锯齿方案分析与优化建议

## 1. 背景与目标

为了确保 PaintBoard 达到专业级的绘画手感和画质，我们需要对标业内标杆 Krita 的笔刷抗锯齿实现。本文档深入分析了 Krita 的源码实现（基于 `libs/image`），对比 PaintBoard 当前的 WebGPU 实现，并提出具体的优化方案。

## 2. Krita 抗锯齿方案深度解析

通过分析 Krita 源码 (`kis_gauss_circle_mask_generator.cpp`, `kis_circle_mask_generator.cpp`, `kis_antialiasing_fade_maker.h`)，我们可以将 Krita 的抗锯齿策略分为三类：

### 2.1 高斯柔边笔刷 (Gaussian Soft Brush)

**核心逻辑**：

- 使用误差函数 (`erf`) 来模拟完美的高斯衰减。
- 关键算法：
  ```cpp
  // source: kis_gauss_circle_mask_generator.cpp
  d->center = (2.5 * (6761.0*d->fade-10000.0))/(M_SQRT_2*6761.0*d->fade);
  d->distfactor = M_SQRT_2 * 12500.0 / (6761.0 * d->fade * effectiveSrcWidth() / 2.0);
  // ...
  val = alphafactor * (erf(dist + center) - erf(dist - center));
  ```
- **特点**：通过数学近似实现了极其平滑的边缘，且支持任意大小的笔刷保持一致的柔和度。

### 2.2 硬边圆形笔刷 (Hard Circle Brush)

**核心逻辑**：

- Krita 的硬笔刷 (`KisCircleMaskGenerator`) **并非简单的 0/1 切割**。
- 它在边缘处（Circle Boundary）会计算一个基于几何的平滑过渡。
- **差异点**：Krita 的边缘抗锯齿逻辑倾向于让 `Radius` 定义为笔刷的**最外层边界**（0% 不透明度），而非通常的 50% 不透明度分界线。
  - 代码迹象：`m_antialiasingFadeStart = radius - 1.0`。即从 `r-1` 到 `r` 进行衰减。
  - 这意味着 Krita 的 10px 笔刷，实心部分只有 8px，剩下 1px 是边缘半透明区。

### 2.3 纹理笔刷 (Texture Brush / Predefined)

- Krita 对位图笔刷的处理依赖于高质量的纹理采样。
- 为了防止在大纹理缩小时产生锯齿（Aliasing），标准图形学做法是使用 **Mipmap**（多级渐远纹理）。

## 3. PaintBoard 现状对比

### 3.1 柔边笔刷 (Soft Brush) - ✅ 已对齐

我们在 `brush.wgsl` 和 `computeBrush.wgsl` 中已经**完全移植**了 Krita 的 `erf` 算法及其魔数常量 (6761.0, 12500.0 等)。

- **结论**：PaintBoard 的柔边笔刷在数学上与 Krita 等效，质量一致。

### 3.2 硬边笔刷 (Hard Brush) - ⚠️ 存在细微差异

PaintBoard 当前使用标准的 shader 抗锯齿方法：

```wgsl
// brush.wgsl
// 1px AA band centered at radius
return 1.0 - smoothstep(radius - 0.5, radius + 0.5, dist);
```

- **差异**：
  - **PaintBoard**：`Radius` 是 50% 不透明度处。笔刷视觉大小 ≈ 设定大小。
  - **Krita**：`Radius` 是 0% 不透明度处（边缘）。笔刷视觉大小略小于设定大小（双边各小 0.5px）。
- **影响**：直接对比时，PaintBoard 的笔刷可能会比 Krita 显得稍微"大"一点点，或者边缘稍微"硬"一点（因为 smoothstep 的曲线比线性更陡峭）。

### 3.3 纹理笔刷 (Texture Brush) - ❌ 待优化

PaintBoard 当前在 `computeTextureBrush.wgsl` 中实现了**手动双线性插值** (`sample_texture_bilinear`)。

- **问题**：我们目前**没有实现 Mipmap**。
- **后果**：当使用高分辨率笔刷素材（如 1000x1000）画小直径笔触（如 10px）时，会因为采样频率不足导致严重的**纹理闪烁 (Sparkling)** 和**边缘锯齿**。
- **现状**：仅依赖 Level 0 的双线性插值在缩小时是不够的。

## 4. 优化方案建议

针对上述分析，提出以下优化任务：

### 任务 1: 实现纹理笔刷的 Mipmap 支持 (高优先级)

**目标**：消除纹理笔刷缩小时的锯齿和噪点。
**方案**：

1.  **加载时生成 Mipmaps**：在 WebGPU 加载笔刷纹理时，生成完整的 Mipmap 链。
2.  **Compute Shader 采样优化**：
    - 在 `computeTextureBrush.wgsl` 中，根据 `dab_size` 和 `texture_size` 计算所需的 LOD (Level of Detail)。
    - 公式参考：`lod = log2(texture_size / dab_size)`。
    - 使用 `textureLoad` 手动实现**三线性插值 (Trilinear Filtering)**（在两个 Mip 层级间进行双线性插值并混合）。
    - 或者，如果 WebGPU Compute Shader 支持，探索使用 `textureSampleLevel`。

### 任务 2: 硬边笔刷边缘对齐 (中优先级)

**目标**：让硬笔刷的边缘控制与 Krita 完全一致（这也是一种"手感"的对齐）。
**方案**：

1.  修改 `computeBrush.wgsl` 中的硬边逻辑。
2.  引入 `EdgeMode` 选项：
    - `Center` (当前 PaintBoard): AA 居中，尺寸最准。
    - `Inner` (Krita 风格): AA 向内缩，边缘也绝不超过半径。
3.  如果用户反馈 PaintBoard 笔刷"发虚"或"偏大"，则切换到 `Inner` 模式。

### 任务 3: 小笔刷亚像素覆盖修正 (已完成)

**状态**：我们在之前的迭代中已经引入了 `Small Brush Optimization` (针对 < 3px 笔刷强制使用高斯模型)，这实际上已经超越了 Krita 的普通处理（Krita 也有类似处理但逻辑略有不同），确保了极细线条不断连。**无需额外改动**。

## 5. 总结

PaintBoard 的核心笔刷引擎目前已经处于非常高的水平，特别是参数化（柔边）笔刷已经达到了 Krita 的标准。主要的提升空间在于**纹理笔刷的抗锯齿**（通过 Mipmap）。

建议立即着手 **任务 1 (Texture Mipmapping)**，这将显著提升纹理笔刷的画质。

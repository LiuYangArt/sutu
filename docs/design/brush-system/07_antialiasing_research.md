# Krita 笔刷抗锯齿方案分析与优化建议

## 1. 背景与目标

为了确保 PaintBoard 达到专业级的绘画手感和画质，我们需要对标业内标杆 Krita 的笔刷抗锯齿实现。本文档深入分析了 Krita 的源码实现（基于 `libs/image`），并全面对比 PaintBoard 的两大渲染引擎（**WebGPU Compute Shader**, **TypeScript CPU Fallback**），提出具体的优化方案。

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

## 3. PaintBoard 现状全引擎对比

### 3.1 柔边笔刷 (Soft Brush) - ✅ 全面已对齐

PaintBoard 的所有引擎均已移植 Krita 的数学模型：

- **Compute Shader (`computeBrush.wgsl`)**: 实现了 `erf` 近似及 Krita 的魔数常量 (`6761.0`, `12500.0`)。
- **CPU Engine (`maskCache.ts`)**: 使用了 lookup table 优化的 `erfFast`，算法逻辑与 GPU 端一致。

**结论**：柔边笔刷在所有平台上的表现一致且符合 Krita 标准。

### 3.2 硬边笔刷 (Hard Brush) - ⚠️ 全引擎统一但存在差异

目前两套引擎的硬边抗锯齿逻辑高度统一，但策略与 Krita 不同：

| 引擎        | 实现代码                      | 逻辑                              | 与 Krita 差异 |
| :---------- | :---------------------------- | :-------------------------------- | :------------ |
| **Compute** | `smoothstep(r-0.5, r+0.5, d)` | 以 Radius 为中心双边各 0.5px 衰减 | 视觉大 ~0.5px |
| **CPU**     | `0.5 - (dist - radius)`       | 线性插值，以 Radius 为中心        | 视觉大 ~0.5px |

- **现状**：PaintBoard 内部一致性很好，但相对于 Krita 的"内缩防锯齿"（AA band 位于 `[Radius-1, Radius]`），PaintBoard 的笔触会显得略宽。

### 3.3 纹理笔刷 (Texture Brush) - ❌ 全引擎待优化

所有引擎目前都缺乏 Mipmap 或高质量下采样支持，导致大纹理缩小时出现严重的锯齿（Aliasing）和闪烁。

#### A. GPU 引擎 (Compute Shader)

- **现状**:
  - `computeTextureBrush.wgsl` (Compute) 使用手动 `mix` 双线性插值。
- **问题**: 仅针对 Base Level (LOD 0) 采样。当 `TextureSize >> BrushSize` 时（如 2000px 贴图用于 20px 笔刷），采样点将跳过大量像素，产生高频噪声。
- **Compute 特有挑战**: Compute Shader 默认无法使用 `textureSampleLevel` 的自动导数计算，需要手动计算 LOD 或传入 Mipmap 层级。

#### B. CPU 引擎 (`textureMaskCache.ts`)

- **现状**: 使用最基础的双线性插值 (`bilinear interpolation`) 逐点计算。
- **问题**: 同样没有 Mipmap 机制。CPU 端如果不做优化，大图缩小的计算量极大且画质差。
- **性能隐患**: 当前 CPU 实现每次笔刷参数变化（如旋转）都会重采样整个 Mask，对于大纹理是严重的性能瓶颈。

## 4. 优化方案建议

针对上述全引擎分析，提出以下优化任务：

### 任务 1: 全局纹理 Mipmap 系统 (高优先级)

**目标**：消除所有引擎中的纹理笔刷锯齿。
**方案**：

1.  **资源加载层**: 在 `BrushTexture` 加载时，不仅解码原始图，还应预生成 Mipmap 链（Canvas API 或 createImageBitmap）。
2.  **GPU 适配**:
    - 上传完整的 Mipmap 链到 GPU Texture。
    - **Compute Shader**: 计算需要的 LOD (`log2(texSize/dabSize)`), 使用 `textureSampleLevel` (如果 WGSL 支持) 或手动实现三线性插值 (Trilinear)。
3.  **CPU 适配**:
    - 在内存中保留 Mipmap 数组。
    - `textureMaskCache.ts` 根据笔刷大小选择最接近的两个 Mipmap 层级进行采样插值，或直接选取较小的一层进行计算，显著减少计算量并提升画质。

### 任务 2: 硬边笔刷模式选项 (中优先级)

**目标**：提供 Krita 风格的硬边手感。
**方案**：

1.  在 `Settings` 中增加 `Brush Edge Mode`: `Center` (Default) vs `Inner` (Sharper/Krita-like)。
2.  **GPU 改动**:
    ```wgsl
    // Inner Mode
    // AA band from r-1.0 to r
    return 1.0 - smoothstep(radius - 1.0, radius, dist);
    ```
3.  **CPU 改动**: 调整 `stampHardBrush` 中的边界判断逻辑以匹配 GPU。

### 任务 3: CPU 纹理缓存性能优化

**目标**：解决 CPU 引擎在大纹理上的性能瓶颈。
**方案**：

- 利用 **任务 1** 的 Mipmap，CPU 总是从最接近目标尺寸的 Mip Level (通常是略大的一层) 进行重采样，避免对 4K 原始贴图进行逐像素遍历。这将带来 10x-100x 的性能提升。

### 任务 4: 小笔刷亚像素覆盖修正 (已完成)

**状态**：我们在之前的迭代中已经引入了 `Small Brush Optimization` (针对 < 3px 笔刷强制使用高斯模型)，这实际上已经超越了 Krita 的普通处理（Krita 也有类似处理但逻辑略有不同），确保了极细线条不断连。**无需额外改动**。

## 5. 总结

PaintBoard 的核心笔刷引擎目前已经处于非常高的水平，特别是参数化（柔边）笔刷已经达到了 Krita 的标准。主要的提升空间在于**纹理笔刷的抗锯齿**（通过 Mipmap）。

---

krita 源码路径 @F:\CodeProjects\krita

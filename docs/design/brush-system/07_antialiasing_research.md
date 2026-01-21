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
- **问题**: 同样没有 Mipmap 机制。CPU 端如果不做优化，大图缩小的计算量极大且画质差。同时，非预乘 Alpha (Straight Alpha) 插值可能导致边缘黑边。
- **性能隐患**: 当前 CPU 实现每次笔刷参数变化（如旋转）都会重采样整个 Mask，对于大纹理是严重的性能瓶颈。

### 3.4 缺失环节：Gamma 校正 (Gamma Correction)

- **问题**: 目前文档主要关注 Alpha 的几何覆盖率，忽略了色彩空间的混合。
- **风险**: Krita 的混合通常在线性空间 (Linear Space) 进行。如果 PaintBoard 直接输出 Alpha 而不进行正确的色彩空间转换（sRGB vs Linear），会导致边缘视觉上变“细”或出现“黑边”。

## 4. 优化方案建议

针对上述全引擎分析，提出以下优化任务：

### 任务 1: 全局纹理 Mipmap 系统 (高优先级)

**目标**：消除所有引擎中的纹理笔刷锯齿，消除“纹理闪烁 (Shimmering)”。
**方案**：

1.  **Mipmap 生成策略 (由于 WebGPU 无 `gl.generateMipmap`)**：
    - **CPU 生成 (V1 - 推荐)**: Canvas API `drawImage` 逐层 Downsample，或 `createImageBitmap`。简单可靠，但增加加载耗时。
    - **GPU 生成 (V2)**: 编写 Compute Shader 或 Render Pass 逐层生成。速度快，工程量大。
2.  **GPU Compute Shader 适配 (手动 LOD)**：
    - 由于 Compute Shader 无自动导数，需**显式计算 LOD**：
      ```wgsl
      let pixelRatio = textureSize.x / currentBrushPixelSize;
      let lod = clamp(log2(pixelRatio), 0.0, maxMipLevel);
      ```
    - **手动三线性插值 (Trilinear)**: 计算 `floor(lod)` 和 `ceil(lod)`，分别双线性采样后 `mix`。
3.  **CPU 适配**:
    - 内存中保留 Mipmap 链。
    - 使用 **Premultiplied Alpha** 格式存储，避免插值时的边缘黑边。

### 任务 2: 硬边笔刷：直接对齐 Krita (Inner Mode)

**目标**：手感与视觉完全对齐 Krita，不增加额外设置选项。
**方案**：

1.  **废弃 "Center" 模式**: 不再提供选项，默认采用 Krita 的 "Inner" 策略。
    - **理由**: 用户在深色背景画亮色时，Center 模式会使笔刷显得“虚胖”。Inner 模式更锐利精确。
2.  **GPU 改动**:
    ```wgsl
    // Inner Mode: AA band 位于 [Radius-1.0, Radius]
    // 意味着 Radius 是绝对边界 (0% Opacity)
    return 1.0 - smoothstep(radius - 1.0, radius, dist);
    ```
3.  **CPU 改动**: 调整 `stampHardBrush` 将 Radius 定义为边缘。

### 任务 3: CPU 引擎深度优化

**目标**：解决 CPU 引擎在大纹理上的性能瓶颈。
**方案**：

1.  **Mipmap 加速**: 总是使用最接近目标尺寸的 Mip Level 进行采样 (10x-100x 提升)。
2.  **逆向采样优化 (Inverse Sampling)**:
    - 不再为每个旋转角度生成新的 Mask。
    - 直接在 `stampToBuffer` 阶段，通过**逆变换矩阵**计算当前像素对应在 Mipmap 上的 UV 坐标。
    - 这消除了 `O(MaskSize)` 的重生成开销，将其转化为 `O(StampArea)` 的采样开销。

### 任务 4: Gamma & 纹理边缘安全 (新增)

**目标**：图形学正确性。
**方案**：

1.  **Gamma Review**: 检查混合管线，确认 Shader 输出的 Alpha 在混合前是否需要 `pow(x, 1.0/2.2)` 补偿，或确认 SwapChain 格式。
2.  **Texture Wrapping**:
    - 强制笔刷纹理使用 `clamp-to-edge`。
    - 确保 Stamp 类笔刷（如树叶）贴图边缘有一圈透明像素，防止 Mipmap 采样导致边缘出现硬切线。

## 5. 验证与风险量化

### 5.1 验证方法 (Confidence Building)

- **1D 截面分析**: 沿笔刷中心线采样 Alpha，对比 Krita 与 PaintBoard 的曲线重合度。
- **2D 差值热力图**: 计算 `|Alpha_Krita - Alpha_PB|`，目标是最大误差 < 1/255。

### 5.2 资源成本

- **内存增加**: 完整的 Mipmap 链会增加约 **33%** 的纹理内存占用。鉴于笔刷贴图通常较小 (1k-2k)，这是完全可接受的。

### 任务 4: 小笔刷亚像素覆盖修正 (已完成)

**状态**：我们在之前的迭代中已经引入了 `Small Brush Optimization` (针对 < 3px 笔刷强制使用高斯模型)，这实际上已经超越了 Krita 的普通处理（Krita 也有类似处理但逻辑略有不同），确保了极细线条不断连。**无需额外改动**。

PaintBoard 的核心笔刷引擎目前已经处于非常高的水平，特别是参数化（柔边）笔刷已经达到了 Krita 的标准。主要的提升空间在于**纹理笔刷的抗锯齿**（通过 Mipmap）。

---

krita 源码路径 @F:\CodeProjects\krita

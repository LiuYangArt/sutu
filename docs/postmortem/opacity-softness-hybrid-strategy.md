# Brush Engine Deep Dive: Softness & Opacity

本文档记录了 PaintBoard 画笔引擎在实现 Softness (Hardness < 100%) 和 Opacity 时的关键技术选型与优化经验，特别是参考 Krita 源码的实现细节与 Hybrid Opacity 策略的由来。

## 1. Gaussian (Error Function) Mask

为了获得与 Photoshop/Krita 一致的柔和笔刷效果，我们引入了基于误差函数 (`erf`) 的高斯遮罩算法。

### 1.1 为什么需要 `erf`？

- **简单 Gaussian (`exp(-kx^2)`)**：虽然也能产生衰减，但在 Hardness 变化时，难以精确控制 "半宽" (FWHM) 和边缘行为。参数难以与 Photoshop 这种工业标准对齐。
- **Krita 实现 (`erf`)**：Krita 使用 `erf` 来计算光圈遮罩，因为 `erf` 是高斯分布的积分，能更物理正确地模拟“模糊圆”的边缘积分效果。

### 1.2 Krita 源码参考

- **文件**: `libs/image/kis_gauss_circle_mask_generator_p.h`, `libs/image/kis_gauss_circle_mask_generator.cpp`
- **核心逻辑**:
  1.  **Fade Parameter**: 将用户可见的 Hardness (0-1) 映射为内部的 `fade` 参数。
      ```cpp
      // Krita 源码逻辑简化
      fade = 1.0 - hardness;
      ```
  2.  **Center & DistFactor**: 为了保证在不同 Hardness 下，笔刷的视觉大小 (Visual Size) 相对稳定，Krita 推导了一套复杂的参数映射公式：
      ```typescript
      // PaintBoard 移植版本 (src/utils/strokeBuffer.ts)
      const center = (2.5 * (6761.0 * fade - 10000.0)) / (SQRT_2 * 6761.0 * fade);
      const alphafactor = 255.0 / (2.0 * erf(center));
      ```
  3.  **计算 Alpha**:
      ```typescript
      val = alphafactor * (erf(scaledDist + center) - erf(scaledDist - center));
      ```

### 1.3 我们的调优 (First Principles Analysis)

在移植后，我们发现直接使用 Krita 的参数在 Hardness 0 时衰减过快（看起来还是像硬笔刷）。

- **优化**: 我们将 `fade` 参数的影响力扩大了 2 倍 (`fade = (1.0 - hardness) * 2.0`)。
- **效果**: 使得 Hardness 0 时的衰减范围更广，产生了类似“喷枪”的极致柔和效果，更符合 Web 端用户的直觉预期。

---

## 2. Opacity 策略演进 (Hybrid Strategy)

Opacity (不透明度) 的处理比预想的复杂，核心矛盾在于 **"积累" (Accumulation)** 与 **"硬边" (Hard Edge)** 的权衡。

### 2.1 早期尝试：Clamp (Ceiling) 模式

- **逻辑**: 每个 Dab (笔触) 在绘制时，Alpha 不能超过 Opacity 值。
  ```typescript
  outAlpha = min(srcAlpha + dstAlpha * (1 - srcAlpha), opacity);
  ```
- **优点**: 硬笔刷效果好，边缘不仅是“半透明”，而且是“实心的一块半透明”，不会因为叠加而变深。
- **缺点 (Fatal)**: **软笔刷 (Soft Brush)** 的中心区域会迅速达到 Opacity 上限，导致高斯渐变被“削平” (Flat-top)，变成了一个实心圆加上一点点模糊边，视觉效果极其糟糕。

### 2.2 改进尝试：Post-Multiply 模式

- **逻辑**: 笔刷在 Buffer 中自然累积 (Flow 控制累积速度)，最高可达 1.0。在 `EndStroke` 合成到图层时，统一乘以 globalOpacity。
- **优点**: 完美保留了高斯分布的梯度，软笔刷效果极其柔和、自然。
- **缺点**: **硬笔刷** 在低 Opacity 时，边缘的抗锯齿 (AA) 像素也被乘了 Opacity，变得更淡，导致视觉上笔刷变细、边缘变虚。用户反馈 "看起来不对"。

### 2.3 最终方案：Hybrid Strategy (混合策略)

为了兼得二者之长，我们实施了混合策略：

| 场景           | 硬笔刷 (Hardness ≥ 95%)                                 | 软笔刷 (Hardness < 95%)                 |
| :------------- | :------------------------------------------------------ | :-------------------------------------- |
| **策略**       | **Clamp (Ceiling)**                                     | **Post-Multiply**                       |
| **Dab 渲染**   | `opacityCeiling = opacity` (限制最大 Alpha)             | `opacityCeiling = undefined` (自然累积) |
| **Flow 调整**  | 不变                                                    | `flow *= opacityPressure` (模拟压感)    |
| **End Stroke** | `finalOpacity = 1.0` (Buffer 已含 Opacity)              | `finalOpacity = opacity` (整体应用)     |
| **Preview**    | **必须特殊处理**：Render Alpha = 1.0 (避免双重 Opacity) | Render Alpha = `opacity` (所见即所得)   |

### 2.4 关键代码位置

- **策略判断**: `src/components/Canvas/useBrushRenderer.ts` -> `processPoint`
- **Dab 渲染**: `src/utils/strokeBuffer.ts` -> `stampDab`
- **Mask 计算**: `src/utils/strokeBuffer.ts` -> `calculateMaskAlpha`
- **常量定义**: `src/constants.ts` -> `HARD_BRUSH_THRESHOLD`

## 3. 经验总结

1.  **所见即所得 (WYSIWYG)**: 笔刷系统的逻辑极其复杂，Preview 的渲染逻辑必须严格跟随 Stroke 的合成逻辑，否则会造成手感断裂（如 "提笔后变色" 问题）。
2.  **第一性原理**: 当遇到“软笔刷有实心感”问题时，不要盲目调参，而是分析 Alpha 合成公式。发现 Flat-top 是 Clamp 逻辑的必然数学结果，从而推导出必须使用 Post-Multiply。
3.  **用户体感优先**: 虽然 Post-Multiply 在数学上更优美，但如果它破坏了硬笔刷的肌肉记忆（变细），就必须妥协。Hybrid 策略就是工程上的实用主义妥协。

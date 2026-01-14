# Brush Engine Deep Dive: Softness & Opacity

本文档记录了 PaintBoard 画笔引擎在实现 Softness (Hardness < 100%) 和 Opacity 时的关键技术选型与优化经验，特别是参考 Krita 源码的实现细节与 Hybrid Opacity 策略的由来。

## 0. 2026-01-14 更新：Alpha Darken 合成模式

### 问题
之前的 Hybrid Strategy（硬笔刷用 Ceiling，软笔刷用 Post-Multiply/dabOpacity）虽然解决了硬/软笔刷一致性问题，但引入了新问题：
1. **透明度累积太快**：opacity=30 就几乎全黑
2. **笔刷点痕迹明显**：opacity=10 时有一圈一圈的 dab 痕迹
3. **压感几乎不影响透明度**：从轻到重变化不明显

### 根因分析

移除 `opacityCeiling` 后使用纯 Porter-Duff over 合成导致 dab 无限累积。

**Porter-Duff Over 公式**：
```
outA = srcA + dstA * (1 - srcA)  // 无限累积，快速趋向 1.0
```

**关键发现**：Krita 并非使用纯 Porter-Duff over，而是使用 **Alpha Darken** 合成模式！

### Krita Alpha Darken 源码追踪

**文件**: `libs/pigment/compositeops/KoCompositeOpAlphaDarken.h:130`
```cpp
fullFlowAlpha = opacity > dstAlpha ? lerp(dstAlpha, opacity, mskAlpha) : dstAlpha;
```

**核心逻辑**：
- 如果 `dstAlpha >= opacity`：**不再增加 alpha**（返回 dstAlpha）
- 如果 `dstAlpha < opacity`：从 dstAlpha 向 opacity **渐进插值**

这是一个 **"软 ceiling"** 机制：
1. 在一次笔触内，累积的 alpha 不会超过 opacity 设置
2. 不是硬 clamp（会导致 flat-top），而是渐进式接近

### 与 Porter-Duff Over 的对比

| 特性 | Porter-Duff Over | Krita Alpha Darken |
|------|------------------|-------------------|
| Alpha 累积 | 无限累积，趋向 1.0 | 限制在 opacity 上限 |
| 多个 dab 叠加 | 快速变深 | 渐进接近 opacity 上限 |
| 低 opacity 效果 | 累积后仍会变深 | 保持在设定的透明度 |

### 最终方案

将 Porter-Duff over 替换为 Alpha Darken 合成：

```typescript
// strokeBuffer.ts - stampDab

// 计算源 alpha（用于插值）
const srcAlpha = maskShape * flow;

// 目标 alpha（累积上限）
const targetAlpha = dabOpacity;

// Alpha Darken 核心逻辑
let outA: number;
if (dstA >= targetAlpha - 0.001) {
  // 已达上限，不再增加
  outA = dstA;
} else {
  // 从 dstA 向 targetAlpha 渐进插值
  outA = dstA + (targetAlpha - dstA) * srcAlpha;
}

// 颜色混合（Krita-style lerp）
const outR = dstA > 0.001 ? dstR + (rgb.r - dstR) * srcAlpha : rgb.r;
```

### 简化的渲染策略

不再区分硬/软笔刷，所有笔刷统一使用相同逻辑：

```typescript
// useBrushRenderer.ts - 统一策略

const dabOpacity = config.pressureOpacityEnabled
  ? config.opacity * dabPressure
  : config.opacity;

// endStroke 时 opacity = 1.0（已在 dab 级别应用）
buffer.endStroke(layerCtx, 1.0);
```

### 验证结果
- 类型检查 ✓
- Lint ✓
- 测试 ✓

### 效果
- ✅ opacity=30 不再快速变黑，保持在设定透明度
- ✅ 压感从轻到重有明显透明度过渡
- ✅ 低 opacity 时无明显 dab 圆圈痕迹
- ✅ 硬/软笔刷表现一致

### 经验教训

1. **不要盲目移除限制逻辑**：之前的 `opacityCeiling` 虽然有 flat-top 问题，但它提供了必要的累积限制
2. **深入研究参考实现**：Krita 的 Alpha Darken 是一个精心设计的"软 ceiling"，既限制累积又保留渐变
3. **合成模式是核心**：Porter-Duff over 适合图层合成，但 stroke buffer 内的 dab 累积需要特殊处理

---

## 1. 2026-01 更新：透明度压感一致性修复

### 问题
不同 hardness 下透明度压感不一致。调整 hardness 时，同样的压力产生不同的视觉透明度。

### 第一性原理分析

**核心原则**：Opacity 必须在 **DAB 级别** 应用，而不是在 endStroke 级别。
这确保每个 dab 的透明度由 **当时的压力** 决定，前面的 dab 不受后面压力影响。

**Krita 的做法**（`kis_painter_blt_multi_fixed.cpp:60`）：
```cpp
localParamInfo.setOpacityAndAverage(dab.opacity, dab.averageOpacity);
```
每个 dab 有自己的 opacity 值，在合成时应用。

### 错误尝试：maxEffectiveOpacity

最初尝试追踪 `maxEffectiveOpacity`，在 endStroke 时作为整个 buffer 的乘数。
**结果**：前面画的部分会随后面压力增大而变深！因为 globalAlpha 影响整个 buffer。

### 正确方案：Ceiling vs Post-Multiply 策略

**核心思路**：根据 `pressureOpacityEnabled` 决定渲染模式，而不是根据 hardness。

| 条件 | 渲染模式 | Dab 阶段 | EndStroke |
|------|----------|----------|-----------|
| 硬笔刷 OR opacity压感 | Ceiling | `ceiling = opacity * pressure` | 1.0 |
| 软笔刷 且 无opacity压感 | Post-Multiply | 无 ceiling | `opacity` |

**关键洞察**：
- 当 `pressureOpacityEnabled = true` 时，**必须** 在 dab 级别应用 opacity
- Post-Multiply 模式只用于软笔刷且没有 opacity 压感的情况

```typescript
// useBrushRenderer.ts

// Ceiling Mode vs Post-Multiply Mode
const useCeilingMode = isHardBrush || config.pressureOpacityEnabled;

if (useCeilingMode) {
  // Opacity at dab level
  ceiling = config.pressureOpacityEnabled
    ? config.opacity * dabPressure  // Per-dab transparency
    : config.opacity;               // Fixed transparency
  renderModeRef.current = 'ceiling';
} else {
  // Opacity at endStroke (soft brush without opacity pressure)
  ceiling = undefined;
  renderModeRef.current = 'postMultiply';
  baseOpacityRef.current = config.opacity;
}

// endStroke
const finalOpacity = renderModeRef.current === 'ceiling' ? 1.0 : opacity;

// Preview
const previewOpacity = renderModeRef.current === 'ceiling' ? 1.0 : baseOpacityRef.current;
```

### 验证
- 类型检查 ✓
- Lint ✓
- 测试 ✓

### 结果
- 每个 dab 的透明度由当时的压力决定
- 前面画的部分不受后面压力影响
- 预览与 endStroke 完全一致

### 问题2：软笔刷渐变被截断（Flat-top 问题）

使用 Ceiling 模式后，软笔刷出现"环状伪影"——中心到边缘的渐变不平滑。

**根因分析**：`opacityCeiling` 是一个 **clamp**（钳制），会截断超过阈值的 alpha 值。
对于软笔刷，mask 本身就有从 1.0 到 0.0 的渐变。当 ceiling 设为 0.5 时，
中心区域 (alpha > 0.5) 全部被截断为 0.5，形成"平顶"效果。

**Krita 的做法**：opacity 是一个 **multiplier**（乘数），不是 ceiling。
```cpp
// KisDabRenderingExecutor.cpp
const quint8 dabOpacity = job->opacity;  // 整个 dab 的不透明度乘数
```
每个像素的最终 alpha = maskAlpha × dabOpacity，这样渐变被等比缩放，不会被截断。

### 最终方案：dabOpacity 乘数模式

**新增参数** `dabOpacity`：作为整个 dab 的乘数，保留渐变。

| 场景 | 使用参数 | 效果 |
|------|----------|------|
| 硬笔刷 | `opacityCeiling` | 钳制最大 alpha，保持实心边缘 |
| 软笔刷 + opacity 压感 | `dabOpacity` | 乘数模式，保留渐变 |
| 软笔刷 无压感 | Post-Multiply | endStroke 时应用 opacity |

```typescript
// useBrushRenderer.ts - 三分支策略

if (isHardBrush) {
  // 硬笔刷：ceiling 模式
  ceiling = config.opacity * dabPressure;
  dabOpacity = 1.0;
} else if (config.pressureOpacityEnabled) {
  // 软笔刷 + opacity 压感：dabOpacity 乘数模式
  ceiling = undefined;
  dabOpacity = config.opacity * dabPressure;
} else {
  // 软笔刷无压感：Post-Multiply
  ceiling = undefined;
  dabOpacity = 1.0;
  // opacity 在 endStroke 时应用
}

// strokeBuffer.ts - stampDab
const maskAlpha = this.calculateMaskAlpha(...);
const dabAlpha = maskAlpha * dabOpacity;  // 乘数保留渐变
```

### 验证
- 类型检查 ✓
- Lint ✓
- 测试 ✓

### 结果
- 软笔刷渐变平滑，与 Krita/Photoshop 一致
- 硬笔刷边缘保持实心
- 每个 dab 的透明度独立，不受后续压力影响

---

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

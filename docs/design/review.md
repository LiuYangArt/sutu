结论先说：**先做 CPU 版，再做 Compute Shader 版**。
但不是“先做完再重写”，而是**“CPU 作为黄金参考实现（Ground Truth）+ GPU 并行实现”**的双轨模式。

---

## ✅ 为什么必须先有 CPU 版（尤其是你要复刻 Photoshop）

你现在已经亲身体验过：

> **Compute 很快，但一旦行为不正确，几乎无法 debug。**

Photoshop 级别的笔刷系统有这些特性：

- 复杂的 **Spacing / Scatter / Rotation / Jitter / Angle dynamics**
- **Pressure / Tilt / Velocity** 驱动的参数
- 多重曲线叠加
- 压感曲线与笔刷纹理的混合

这些逻辑如果没有一个“确定正确”的 CPU 参考实现，GPU 版本就会变成“猜性能 + 猜正确性”。

CPU 版给你的价值是：

✅ **可调试**
✅ **可逐步验证**（1:1 像素对比）
✅ **作为 regression 测试基准**
✅ **更容易实现复杂行为**

---

## ✅ 正确的开发节奏（推荐流程）

### 第 1 阶段：CPU 版为“规范实现”

- 功能优先，性能不重要
- 每一步都可以单步调试
- 生成的结果用于对比 GPU 版

### 第 2 阶段：GPU 版复刻 CPU 行为

- 每个 feature 要通过 “CPU vs GPU diff test”
- 每个 dab 的 mask、blend、opacity 都一致

### 第 3 阶段：GPU 优化

- Tile Culling
- BBox batching
- Shared Memory
- 通道压缩 / LUT

---

## ✅ 你现在的最佳实践可以这样组织

### 1. 统一“笔刷数学模型”

把所有与 **笔刷形状/透明度/混合**有关的公式抽成纯函数：

```ts
// brushMath.ts
export function computeMask(dist, radius, hardness) { ... }
export function alphaDarkenBlend(bg, fg, mask, flow, opacity) { ... }
```

CPU 版 & GPU 版使用同一数学模型（CPU 是 JS 实现，GPU 是 WGSL 复刻）。

### 2. 先实现 CPU，GPU 做“像素一致性回归”

建立一个自动测试：

```
CPU output vs GPU output
error < 2/255
```

这能让你快速验证 GPU 新 feature 的正确性。

---

## ✅ 什么时候可以直接上 Compute Shader？

只有这几种情况可以：

✅ **行为很简单**（比如单色硬圆点）
✅ **已有明确 CPU 版可参考**
✅ **需要纯性能验证**

其他情况（尤其是动态参数、多重 brush mix）都不建议直接上 GPU。

---

## ✅ 建议的开发策略总结（一句话）

> **CPU 是“真理”，Compute 是“加速器”。**

---

如果你愿意，我可以帮你设计一个完整的“Photoshop 笔刷系统模块分层架构”，例如：

- Brush Engine Core
- Dynamics Layer
- Dab Generator
- Stroke Sampler
- Renderer (CPU / GPU)

你只要告诉我你想支持的 Photoshop 特性清单，我可以给你一份可落地的架构草图 + 实现路线图。

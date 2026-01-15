# GPU 软笔刷边缘裁切问题修复

> **日期**: 2026-01-16
> **问题**: hardness 0~0.6 的软笔刷，Gaussian 渐变边缘被裁切
> **修复**: 增大 Vertex Shader 几何扩展系数，保持 Fragment Shader 不变

---

## 问题现象

软笔刷（hardness < 0.6）在 GPU 渲染时，边缘出现明显的"硬边界"，Gaussian 渐变在此处被突然截断，而不是平滑衰减到透明。

## 根因分析

### Quad 尺寸不足

原始代码使用相同的 `fade` 系数同时用于：
1. Vertex Shader 的几何扩展（Quad 尺寸）
2. Fragment Shader 的 Gaussian 曲线计算

```wgsl
// 原始代码
let fade = (1.0 - instance.hardness) * 2.0;
let extent_multiplier = 1.0 + fade;
```

问题：Gaussian 曲线的尾部需要更大的空间才能完全衰减到接近 0，但 Quad 尺寸不够大，导致边缘被裁切。

### 关键洞察

**几何扩展和 Gaussian 曲线是两个独立的概念**：
- **几何扩展**: 决定渲染区域的大小，需要足够大以容纳完整的渐变
- **Gaussian 曲线**: 决定笔刷的视觉软度，不应修改以保持手感一致

## 解决方案

**只增大几何扩展，不修改 Gaussian 曲线**

```wgsl
// Vertex Shader: 几何扩展用 2.5 系数，最小 extent 1.5
let geometric_fade = (1.0 - instance.hardness) * 2.5;
let extent_multiplier = select(1.0, max(1.5, 1.0 + geometric_fade), instance.hardness < 0.99);

// Fragment Shader: 保持原有 fade = 2.0，Gaussian 曲线不变
let fade = (1.0 - in.hardness) * 2.0;
```

## 修改文件

| 文件 | 修改 |
|------|------|
| `src/gpu/shaders/brush.wgsl` | Vertex Shader 几何扩展系数 2.0 → 2.5，最小 extent 1.5 |
| `src/gpu/types.ts` | 同步 `calculateEffectiveRadius()` 函数 |

## 经验教训

### 1. 分离关注点

几何尺寸和视觉效果是两个独立的问题：
- 几何尺寸：确保有足够的像素空间
- 视觉效果：控制颜色/透明度的分布

修改几何尺寸不会影响视觉效果，只要 Fragment Shader 的公式不变。

### 2. 保守修改原则

当修复渲染问题时，优先选择影响范围最小的方案：
- ✅ 只改 Vertex Shader 的几何扩展
- ❌ 不改 Fragment Shader 的 Gaussian 曲线（会改变笔刷手感）

### 3. GPU/CPU 同步

当 GPU shader 有对应的 TypeScript 计算函数时，两者必须保持同步：
- `brush.wgsl` 的 `extent_multiplier` 计算
- `types.ts` 的 `calculateEffectiveRadius()` 函数

### 4. 性能影响评估

Quad 扩大约 25%（从 2.0 到 2.5 系数），但：
- 现代 GPU 对这种扩展不敏感
- Fragment Shader 仍会 discard 超出范围的像素
- 实际性能影响可忽略

## 验证方法

1. 测试 hardness=0.0, 0.3, 0.5, 0.6 的软笔刷
2. 确认边缘完整、不再被裁切
3. 对比修改前后 hardness=0.5，确保只是"边缘变完整"而非"笔刷变大或变虚"

## 相关文档

- 设计方案: `docs/design/gpu-soft-brush-edge-fix-plan.md`
- 相关问题: `docs/postmortem/soft-brush-and-stroke-taper.md`

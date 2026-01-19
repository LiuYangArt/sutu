# GPU Brush Anti-Aliasing 优化经验

> Issue: https://github.com/LiuYangArt/PaintBoard/issues/83
> 日期: 2025-01-19
> 状态: ✅ 已完成

## 问题描述

GPU Compute Shader 渲染的笔触边缘有明显锯齿，与 CPU 渲染效果差异较大。

**测试条件**: Size=127, Hardness=1, Flow=0.3, Opacity=1.0, Spacing=20%

### 症状

1. **大笔刷**: 边缘锯齿明显，Max Diff: 64-85
2. **小笔刷 (1px)**: 线条有断裂感

---

## 根因分析

### 原始 GPU 实现问题

原始代码 (`computeBrush.wgsl`) 对硬笔刷使用**归一化距离**进行抗锯齿：

```wgsl
// 错误实现
let pixel_size = 1.0 / radius;  // 当 radius=100 时，pixel_size = 0.01
let half_pixel = pixel_size * 0.5;
let edge_dist = normalized_dist - 1.0;  // normalized_dist = dist / radius
```

**问题**: 归一化后的 `pixel_size` 对于大半径笔刷极小（如 radius=100 时为 0.01），导致抗锯齿带宽度远小于 1 像素，视觉上等于没有抗锯齿。

### CPU Reference 实现

CPU 端 (`src/utils/maskCache.ts` `stampHardBrush()`) 使用**物理像素距离**：

```typescript
// CPU 正确实现
const physicalDist = normDist * radiusX;  // 物理距离
const edgeDist = radiusX;

if (physicalDist <= edgeDist - 0.5) {
  maskValue = 1.0;  // 完全不透明
} else if (physicalDist >= edgeDist + 0.5) {
  maskValue = 0;    // 完全透明
} else {
  // 1px 宽的线性过渡
  maskValue = 0.5 - (physicalDist - edgeDist);
}
```

**关键差异**: CPU 使用物理距离确保抗锯齿带始终是 **1 像素宽**，与笔刷大小无关。

---

## 最终修复方案

### 1. 小笔刷 (radius < 3px): 高斯光晕模型

对所有硬度的小笔刷统一使用高斯分布，解决"采样频率不足"导致的断裂问题：

```wgsl
if (radius < 3.0) {
  let base_sigma = max(radius, 0.5);
  let softness_factor = 1.0 + (1.0 - hardness);  // 软笔刷 sigma 更大
  let sigma = base_sigma * softness_factor;

  var alpha = exp(-(dist * dist) / (2.0 * sigma * sigma));

  // 1.5-3px 硬笔刷：渐进式锐化边缘
  if (hardness >= 0.99 && radius >= 1.5) {
    let blend = (radius - 1.5) / 1.5;
    let sharp_alpha = 1.0 - smoothstep(radius - 0.5, radius + 0.5, dist);
    alpha = mix(alpha, sharp_alpha, blend * hardness);
  }

  return min(1.0, alpha);
}
```

**原理**: 高斯函数拥有更长的"尾巴"，能更好地将颜色能量扩散到周围像素，保持线条视觉连续性。

### 2. 大笔刷 (radius >= 3px): 物理距离 AA

使用 `smoothstep` 简化后的 1px 抗锯齿：

```wgsl
if (hardness >= 0.99) {
  return 1.0 - smoothstep(radius - 0.5, radius + 0.5, dist);
}
```

### 3. ABR 纹理笔刷

同样的高斯光晕方案应用于 `computeTextureBrush.wgsl`，小笔刷使用高斯 + 纹理混合过渡。

---

## 修复效果

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| Max Diff (大笔刷) | 64-85 | **3** |
| Diff Pixels | 2-3% | **0.0007%** |
| 边缘质量 | 锯齿明显 | **平滑** |
| 小笔刷 (1px) 连续性 | 断裂严重 | **连续平滑** |
| 小笔刷 (不同硬度) | 断裂 | **全部支持** |

---

## 修改文件

- `src/gpu/shaders/computeBrush.wgsl` - 参数化笔刷
- `src/gpu/shaders/computeTextureBrush.wgsl` - ABR 纹理笔刷

---

## 关键教训

1. **物理距离 vs 归一化距离**: 抗锯齿必须在物理像素空间计算，归一化会导致大笔刷的 AA 带过窄
2. **小笔刷采样不足**: 当笔刷尺寸 < 3px 时，点采样无法捕获覆盖率，需要用高斯光晕模拟
3. **高斯 vs smoothstep**: 高斯有"尾巴"，能保持视觉连续性；smoothstep 是硬截断
4. **GPU/CPU 一致性**: 先理解 CPU Reference 的实际实现，再移植到 GPU
5. **渐进过渡**: 小笔刷和大笔刷之间需要平滑过渡，避免视觉跳变

---

## 参考文档

- `docs/design/gpu-optimization-plan/debug_review.md` - 小笔刷优化方案分析
- `docs/design/gpu-optimization-plan/gpu-batch-rendering-compute.md` - Compute Shader 架构

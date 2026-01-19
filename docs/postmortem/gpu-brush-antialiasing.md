# GPU Brush Anti-Aliasing 优化经验

> Issue: https://github.com/LiuYangArt/PaintBoard/issues/83
> 日期: 2025-01-19
> 状态: 部分完成，小笔刷仍有改进空间

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

## 修复方案

### 修改 1: 硬笔刷使用物理距离抗锯齿

```wgsl
fn compute_mask(dist: f32, radius: f32, hardness: f32) -> f32 {
  if (hardness >= 0.99) {
    // 使用物理像素距离，不是归一化距离
    let edge_dist = radius;

    if (dist <= edge_dist - 0.5) {
      return 1.0;  // 完全内部
    } else if (dist >= edge_dist + 0.5) {
      return 0.0;  // 完全外部
    } else {
      // 1px 抗锯齿带
      return 0.5 - (dist - edge_dist);
    }
  }
  // ... 软笔刷保持高斯 erf
}
```

### 修改 2: 小笔刷特殊处理

当 `radius < 1.0` 时，整个 dab 都在抗锯齿过渡区内，导致没有完全不透明的中心像素：

```wgsl
if (radius < 1.0) {
  let norm_dist = dist / max(radius, 0.1);
  // smoothstep 确保中心像素有较高不透明度
  return 1.0 - smoothstep(0.0, 1.5, norm_dist);
}
```

### 修改 3: 小笔刷有效半径

确保小笔刷的有效半径足够大，防止 dab culling 错过像素：

```wgsl
fn calculate_effective_radius(radius: f32, hardness: f32) -> f32 {
  if (radius < 2.0) {
    return max(1.5, radius + 1.0);  // 小笔刷保证最小 1.5px
  }
  // ... 大笔刷使用 geometric fade
}
```

---

## 修复效果

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| Max Diff (大笔刷) | 64-85 | 3 |
| Diff Pixels | 2-3% | 0.0007% |
| 边缘质量 | 锯齿明显 | 平滑 |
| 小笔刷连续性 | - | 有改善，仍有优化空间 |

---

## 待改进

### 1. 小笔刷 (1px) 断裂问题

当前 smoothstep 方案改善了问题，但与 CPU 仍有差异。可能需要：

- 检查 CPU 对小笔刷的具体处理逻辑
- 考虑使用更激进的 falloff 参数
- 或者对极小笔刷直接返回固定值

### 2. 软笔刷高硬度过渡

当 `hardness` 接近 0.99 但未达到阈值时，高斯 erf 的 `safe_fade` 很小，曲线可能过于陡峭。可能需要：

- 平滑过渡硬笔刷和软笔刷算法
- 或者调整 `hardness >= 0.99` 的阈值

---

## 相关文件

- `src/gpu/shaders/computeBrush.wgsl` - GPU Compute Shader
- `src/utils/maskCache.ts` - CPU Reference (stampHardBrush)
- `src-tauri/src/brush/soft_dab.rs` - Rust 软笔刷实现 (使用高斯 erf)

---

## 关键教训

1. **物理距离 vs 归一化距离**: 抗锯齿必须在物理像素空间计算，不能归一化
2. **小笔刷边界情况**: 当笔刷尺寸接近或小于抗锯齿带宽度时，需要特殊处理
3. **GPU/CPU 一致性**: 先理解 CPU Reference 的实际实现，再移植到 GPU

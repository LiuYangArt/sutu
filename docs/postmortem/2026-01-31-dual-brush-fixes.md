# Dual Brush 方向性伪影与尺寸缩放修复总结

## 问题背景

在实现 Dual Brush (双重画笔) 功能时，用户反馈了三个主要视觉问题：

1. **方向性伪影**：纵向绘制时笔触明显变窄/被裁剪，而横向绘制正常。
2. **Scatter 分布异常**：纵向绘制时 Scatter 效果看起来像是被压缩在一条线上。
3. **尺寸缩放不匹配**：次级笔刷 (Secondary Brush) 的大小与 Photoshop 行为不一致，且看起来过大。

## 问题分析与修复

### 1. 方向性伪影 (Directional Artifacts)

**现象**：
使用非正方形纹理的主笔刷时，纵向笔划宽度明显小于横向笔划。

**根因分析**：
`prepareDualMask` 方法在确定从 Accumulator 采样的区域大小时，错误地使用了 **主笔刷纹理变换后的大小** (`scaledWidth`, `scaledHeight`)。

- 当纹理长宽比不为 1 时（例如宽扁），旋转 90 度后，垂直方向的采样高度不足。
- 导致 Accumulator 中的数据被错误地“截断”或映射到较小的区域。

**修复方案**：
放弃使用纹理尺寸作为采样参考。改用 **主笔刷的物理尺寸 (`params.size`)** 作为采样区域的基准。

- 无论纹理长宽比如何，采样区域始终是 `size * size` 的正方形。
- 采样后，再通过线性插值映射到目标 Buffer。

```typescript
// Old (Buggy)
// const dualMask = this.prepareDualMask(params, this.textureMaskCache.getScaledWidth(), ...);

// New (Fixed)
// Inside prepareDualMask:
const sampleSize = params.size; // Always square
// ... map sampleSize to output buffer dimensions
```

### 2. Scatter 方向问题

**现象**：
当未勾选 "Both Axes" 时，纵向笔划的粒子没有在 X 轴方向散开，而是集中在中心线上。

**根因分析**：
代码中 `!bothAxes` 的逻辑简单地将 `dx` 设为 0，保留 `dy`。

- 这隐含假设了笔划是 **水平向右** 的（此时垂直分散即为 Y 轴分散）。
- 对于 **垂直笔划**，垂直于路径的分散应该是 X 轴 (`dx`)，但被强制设为 0 了。
- 根本原因是 `stampSecondaryDab` 缺少当前笔划的方向信息 (`direction`)。

**修复方案**：
暂时强制在所有情况下都启用双轴 Scatter。

- `dx` 和 `dy` 都进行随机化。
- 这虽然不是完美的 "Single Axis" 实现，但避免了方向性导致的视觉崩坏（至少是均匀分布的）。
- **后续优化**：需要透传 `direction` 参数以正确计算垂直于路径的偏移向量。

### 3. 次级笔刷尺寸缩放 (Size Scaling)

这个没修好，后续再说。

## 经验总结

1. **纹理采样必须各向同性**：在处理旋转和非正方形纹理的蒙版生成时，中间态的采样区域（Sampling Region）最好保持正方形，仅在最终映射阶段处理长宽比，以避免方向性偏差。
2. **PS 参数的物理含义**：Photoshop 的参数往往是基于“当前状态”和“基础状态”的比率，而不是简单的绝对值或任意常数（如 128px）的缩放。理解参数在 UI 上的语义（即用户预期的“所见即所得”）至关重要。
3. **坐标系的隐含假设**：在处理 Scatter 等几何变换时，默认的 X/Y 轴逻辑往往只适用于水平线。必须时刻警惕这种隐含假设，特别是在处理任意方向的笔划时。

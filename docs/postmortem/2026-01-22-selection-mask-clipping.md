# Selection Mask Clipping - 坐标系统不匹配导致的偏移问题

**日期**: 2026-01-22
**状态**: 🔴 未解决
**影响**: 选区裁切功能在 zoom 变化时出现位置偏移

## 问题描述

实现选区功能时，需要在有选区的情况下限制绑画只能在选区内进行。实现了 GPU 层的 mask 裁切后，发现：

1. **绘画内容与选区边界存在偏移**
2. **偏移量随 zoom 值变化** - 这是关键线索

## 尝试过的方案

### 方案 1: Dab 中心点过滤 ❌

在 `useBrushRenderer.ts` 的 dab 循环中添加 `isPointInSelection()` 检查：

```typescript
for (const dab of dabs) {
  if (hasSelection && !selectionState.isPointInSelection(dab.x, dab.y)) {
    continue;
  }
  // ...
}
```

**问题**: 只过滤 dab 中心点，dab 边缘仍会溢出选区边界，无法实现像素级裁切。

### 方案 2: GPU Preview 层像素级裁切 ❌

在 `GPUStrokeAccumulator.ts` 的 `updatePreview()` 中添加 mask 查询：

```typescript
const globalX = rect.left + px;
const globalY = rect.top + py;

if (selectionMask) {
  const maskIdx = (globalY * selectionMask.width + globalX) * 4 + 3;
  if ((selectionMask.data[maskIdx] ?? 0) === 0) continue;
}
```

**问题**: 偏移量随 zoom 变化，说明坐标系统存在不匹配。

### 方案 3: 使用整数坐标 ❌

将 `rect.left/top` 改为 `Math.floor()` 确保整数坐标：

```typescript
const rect = {
  left: Math.floor(Math.max(0, this.dirtyRect.left)),
  top: Math.floor(Math.max(0, this.dirtyRect.top)),
  // ...
};
```

**问题**: 偏移问题仍然存在。

### 方案 4: 移除 GPU 层裁切，只依赖 CPU 过滤 ❌

完全移除 GPU 层的 mask 裁切逻辑。

**问题**: 这样根本没有像素级裁切，功能完全失效。这是**错误的方向**。

## 根因分析

### 坐标系统复杂性

PaintBoard 存在多个坐标系统：

1. **Screen 坐标**: `e.clientX/Y` - 屏幕像素
2. **Container 坐标**: 相对于 canvas 容器
3. **Document 坐标**: `(e.clientX - rect.left) / scale` - 文档逻辑像素
4. **GPU Texture 坐标**: `documentCoord * currentRenderScale` - 可能是 0.5x 或 1.0x

### 关键因素

1. **Canvas 有 CSS Transform**: `transform: translate(offsetX, offsetY) scale(scale)`
2. **GPU 有 RenderScale**: `currentRenderScale` 可能是 0.5（大笔刷低硬度时降采样）
3. **Selection Mask 是文档尺寸**: 按 1:1 比例生成

### 偏移产生原因

当 zoom 变化时：
- `dirtyRect` 坐标是文档坐标
- `selectionMask` 坐标也是文档坐标
- **但 GPU 纹理使用了 `currentRenderScale` 进行缩放渲染**

在 `updatePreview` 中，`globalX/Y` 用于 mask 查询，`texX/Y = globalX * scale` 用于纹理采样。
问题可能在于 **mask 坐标和实际渲染位置之间存在缩放因子的不一致**。

## 教训总结

### 1. 不要在不理解坐标系统的情况下盲目修改

这个项目存在复杂的多层坐标转换：
- Viewport transform (offsetX, offsetY, scale)
- GPU render scale (0.5x/1.0x)
- Document vs Screen coordinates

在修改坐标相关代码前，**必须完整理解整个坐标转换链**。

### 2. 不要轻易移除功能来"简化"问题

移除 GPU 层的 mask 裁切是错误的决定。正确的做法是：
- 添加调试日志确认具体偏移量
- 找出 zoom 和偏移的数学关系
- 修复坐标转换而非删除功能

### 3. 调试策略

对于坐标偏移问题，应该：
1. 在 mask 查询处添加日志，输出 `globalX/Y` 和对应的 mask 值
2. 对比选区边界 (`bounds`) 和实际裁切边界
3. 测试 zoom=1.0, zoom=0.5, zoom=2.0 等不同值，找出规律

### 4. 选区 Mask 的正确实现路径

更好的实现方案可能是：
1. **在 GPU Shader 中实现裁切** - 将 mask 作为纹理传入 shader
2. **使用 Canvas 2D clip()** - 如果走 CPU 渲染路径
3. **确保坐标系统完全统一** - mask 和渲染使用相同的坐标空间

## 待解决

- [ ] 添加调试日志，确认 zoom 与偏移的精确关系
- [ ] 检查 `currentRenderScale` 对坐标的影响
- [ ] 考虑在 shader 层面实现 mask 裁切
- [ ] 或者确保 mask 和渲染使用完全相同的坐标变换

## 相关文件

- `src/gpu/GPUStrokeAccumulator.ts` - GPU 渲染和 preview 更新
- `src/stores/selection.ts` - 选区状态和 mask 生成
- `src/components/Canvas/useSelectionHandler.ts` - 选区交互
- `src/components/Canvas/useBrushRenderer.ts` - 笔刷渲染

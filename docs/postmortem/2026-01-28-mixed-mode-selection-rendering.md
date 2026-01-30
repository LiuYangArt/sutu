# 混合模式选区平滑方案复盘 (Postmortem)

**日期:** 2026-01-28
**状态:** 已落地
**模块:** Selection System

## 1. 问题描述 (Problem)

在优化套索工具（Lasso Tool）时，我们遇到了两个顽固的视觉问题，严重影响了混合使用“自由手绘”和“多边形点击”时的体验：

1.  **闭合处圆弧 (Arc on Close)**：
    即使松开鼠标希望直线闭合选区，算法也会试图将终点和平滑地“圆”回起点，导致最后一条边变成奇怪的弧线，而不是预期的直线。
2.  **混合选区无尖角 (Loss of Sharp Corners)**：
    当用户在一次选区操作中混合使用拖拽（Freehand）和 Alt+点击（Polygonal）时，平滑算法会“一视同仁”地平滑所有点，导致用户刻意点击出的锐利尖角被磨平。

## 2. 根因分析 (Root Cause)

### 2.1 全局闭环平滑

原有的 `drawSmoothMaskPath` 算法默认将输入点集视为**闭合回路**。它会计算最后一点到第一点的控制点并进行插值。这对于纯手绘圆圈很棒，但对于“未闭合的手绘线段”也是强制闭环，从而产生了“Arc on Close”。

### 2.2 缺乏语义信息

`pathToMask` 渲染函数接收的是一个简单的 `Point[]` 数组。它无法区分哪些点是用户“拖”出来的（需要平滑），哪些点是不同时机“点”下去的（不仅是位置，更是**锚点**）。全量应用 Chaikin/Catmull-Rom 算法必然会破坏这些锚点的几何特征。

## 3. 解决方案 (Solution)

我们放弃了“基于整个选区模式（Global Lasso Mode）”的平滑策略，转向了**基于点语义的分段渲染（Segment-Based Rendering）**。

### 3.1 引入点类型 (Point Typing)

在 `SelectionPoint` 接口中增加 `type` 字段：

```typescript
interface SelectionPoint {
  x: number;
  y: number;
  type?: 'freehand' | 'polygonal';
}
```

在 `useSelectionHandler` 中：

- `pointerMove` 产生的拖拽点标记为 `freehand`。
- `pointerDown` (点击/Alt+点击) 产生的点标记为 `polygonal`。

### 3.2 分段渲染管道 (Segmented Pipeline)

重构 `selection.ts` 中的 `pathToMask`，不再一次性平滑整个路径，而是根据点类型动态分段：

1.  **Buffer 机制**：遍历路径点，将连续的 `freehand` 点推入缓冲区。
2.  **遇到 Polygonal 点**：
    - **Flush**：立即对缓冲区内的手绘片段应用平滑算法并绘制。
    - **LineTo**：直接用直线连接到当前的 Polygonal 点（保留尖角）。
    - **Reset**：清空缓冲区，开始下一段记录。
3.  **直线闭合**：路径结束后，调用 Canvas 原生的 `ctx.closePath()`，确保首尾以直线相连，彻底解决圆弧闭合问题。

### 3.3 开放路径平滑 (Open Path Smoothing)

改造 `drawSmoothMaskPath` 支持 `closePath = false` 模式：

- 不再回卷数组索引（不连接 `last -> first`）。
- 使用 `ctx.lineTo` 衔接片段起点，保证分段绘制时的笔触连续性。

## 4. 效果 (Outcome)

该方案实现了真正的 Photoshop 级混合选区体验：

- **拖拽**产生平滑曲线。
- **点击**产生锐利折线。
- **混合操作**时，曲线与直线自然过渡，尖角完美保留。
- **闭合**总是通过直线完成，行为符合预期。

## 5. 经验总结

在处理复杂的交互式绘图时，**Context is King**。仅仅记录坐标是不够的，记录坐标产生的**意图**（是画线？还是定点？）对于后续的高质量渲染至关重要。将数据结构升级为带类型信息的节点序列，是解决此类混合渲染问题的通用解法。

# 研究报告：选区平滑问题与 Krita 实现分析

> 日期: 2026-01-28
> 状态: 研究完成

## 1. 为了解决什么问题？

用户反馈“选区填充”时平滑处理不当，具体表现为：本应是尖锐棱角的“多边形选区”出现了圆角，或者边缘存在伪影。
本研究的目标是分析 Krita 的选区渲染实现，并与 PaintBoard 的当前方案进行对比，以找出根本原因并确定最佳实践。

## 2. Krita 实现分析

我深入分析了 Krita 的源代码，重点关注以下文件：

- `plugins/tools/selectiontools/kis_tool_select_polygonal.cc` (多边形套索)
- `plugins/tools/selectiontools/kis_tool_select_outline.cc` (手绘/自由套索)
- `libs/ui/tool/KisToolOutlineBase.cpp` & `kis_tool_polyline_base.cpp` (输入处理)

### 核心发现

1.  **统一的路径构建方式**:
    - Krita 的多边形（Polygonal）和手绘（Freehand）工具都使用 `addPolygon(points)` 来构建 `QPainterPath`。
    - `addPolygon` 本质上是用直线段（`lineTo`）连接各个点。
    - **不做曲线拟合**: Krita 在选区工具中**没有**对输入点应用贝塞尔曲线拟合（如 Catmull-Rom 或样条平滑）。

2.  **通过“密度”实现平滑**:
    - **多边形工具**: 点是用户点击的顶点，线是直的（保留尖角）。
    - **手绘工具**: 点来自于高频率的鼠标/数位板事件。曲线的“平滑”感来自于大量细小的直线段的密集连接，而非数学上的曲线拟合。

3.  **光栅化 (Rasterization) 与 抗锯齿**:
    - Krita 使用 `KisPainter::paintPainterPath` 渲染选区遮罩。
    - **关键点**: 两个工具都显式开启了抗锯齿 (`painter.setAntiAliasPolygonFill(true)`)（除非开启了羽化）。
    - **结论**: 这保证了边缘是柔和的（抗锯齿的），但几何形状忠实于输入点（多边形保持尖角）。

## 3. PaintBoard 当前实现

PaintBoard 的实现 (`src/stores/selection.ts`) 与 Krita 有显著差异：

```typescript
function pathToMask(path, ..., lassoMode) {
  // ...
  // 大于20个点且模式为 freehand 时尝试平滑
  const shouldSmooth = lassoMode === 'freehand' && path.length > 20;
  if (shouldSmooth) {
    const simplified = simplifyPath(path, 1.5);
    drawSmoothMaskPath(ctx, simplified); // 使用 Catmull-Rom 样条曲线
  } else {
    // 普通的直线连接
  }
}
```

### 发现的问题

1.  **曲线拟合 vs 输入保真度**: PaintBoard 试图通过 `simplifyPath` + `Catmull-Rom` 对手绘选区进行平滑。虽然这能消除手抖，但如果误用（例如 `lassoMode` 状态错误，或阈值过于激进），就会导致意料之外的圆角。
2.  **多边形圆角 Bug**: 用户提供的截图中，多边形选区出现了圆角。这强烈暗示 `pathToMask` 错误地执行了 `shouldSmooth` 分支。
    - **原因**: 在使用多边形工具时，`lassoMode` 可能被错误地设置为了 `'freehand'`，或者在创建/填充时的状态传递逻辑有误。

## 4. 建议与方案

### 针对“顺滑无锯齿”的回答

**这个方案完全可以实现顺滑且无锯齿的边缘。**

我们需要区分两个概念：

1.  **几何平滑 (Geometric Smoothing)**: 改变路径形状（把尖角变圆）。当前的问题是多边形被错误地做了一次几何平滑。
2.  **边缘抗锯齿 (Anti-aliasing)**: 在像素层面让边缘过渡柔和，消除锯齿感。

**推荐方案**:
我们在修复几何形状（让多边形变回尖角）的同时，依然会保留 Canvas 的抗锯齿渲染。
Canvas 的 `ctx.fill()` 默认就支持抗锯齿。只要我们不错误地改变几何路径，就能得到**形状准确（尖角）且边缘柔和（无像素锯齿）**的效果。

### 具体实施步骤

#### 第一步：修复 Bug (Immediate Fix)

确保 `lassoMode` 被正确传递和持久化。

- 验证 `useToolStore` 在切换工具时是否正确设置了 `lassoMode`。
- 确保 `useSelectionStore.commitSelection` 读取的是正确的 `lassoMode`。
- **效果**: 多边形工具将不再产生错误的圆角。

#### 第二步：策略改进 (向 Krita 看齐)

考虑移除或限制手绘模式的 `Catmull-Rom` 曲线平滑。

- **原因**: 强制曲线拟合会改变用户的绘制意图，导致“过冲”或形状变形。
- **建议**:
  - **多边形**: 永远使用 `lineTo` (确保尖角)。
  - **手绘**: 优先使用 `lineTo` (依赖输入点的密度)。如果输入事件太稀疏，可以使用非常保守的平滑算法（如 Chaikin 算法），或者仅在点距非常大时才平滑。

## 5. 下一步行动

1.  **Fixing**: 调试 `SelectionOverlay.tsx` 和 `selection.ts`，修复 `lassoMode` 状态问题。
2.  **Verification**: 确认修复后，多边形选区是否恢复尖角，且边缘依然有抗锯齿效果。

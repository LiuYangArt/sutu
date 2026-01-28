# 选区平滑实现复盘 (Postmortem)

日期: 2026-01-28
状态: 已解决

## 1. 背景 (Context)

为了对标专业绘画软件（如 Photoshop），我们需要优化选区填充的平滑度。原有的实现中，自由套索（Freehand Lasso）产生的选区边缘存在明显的锯齿和像素化。

## 2. 实施的变更 (Changes Implemented)

### 第一阶段：自由选区平滑 (Freehand Smoothing)

- **算法**：使用 **Chaikin 细分算法**（加权控制点的二次贝塞尔曲线）替代原始的直线连接。
- **降噪**：应用 **Ramer-Douglas-Peucker (RDP)** 简化算法（容差: 1.5px）以去除输入噪点。
- **约束**：放弃了 Catmull-Rom（会导致更严重的溢出），改用 Chaikin 以保证曲线严格位于多边形的凸包内。

### 第二阶段：笔刷抗锯齿 (Brush Anti-aliasing)

- **问题**：即使选区遮罩本身是平滑的，在选区内使用笔刷绘图时，边缘依然有锯齿。
- **修复**：更新 `GPUStrokeAccumulator`，使用选区遮罩的 Alpha 通道作为混合因子 (`maskAlpha / 255`)，而不仅仅是二值检查 (`maskAlpha === 0`)。

### 第三阶段：多边形与自由选区区分 (Polygonal vs. Freehand)

- **逻辑**：修改 `pathToMask` 函数以接收 `lassoMode` 参数。
- **区分策略**：
  - `freehand` (且点数 > 20)：应用平滑算法。
  - `polygonal`：使用标准的 `lineTo` 绘制，保留锐利尖角。

## 3. 遇到的问题：多边形失配 ("Polygonal Mismatch")

### 观察到的现象

尽管添加了禁用多边形选区平滑的逻辑，用户反馈显示 **多边形选区填充依然被圆润化/收缩**，与视觉轮廓（蚂蚁线）不符。

### 症状

- 填充区域没有完全覆盖选区点定义的区域。
- 尖角被变圆，填充范围比虚线轮廓“缩进”了一圈。

### 根因分析 (Root Cause Analysis)

经过调查，发现**状态持久化缺失**是根本原因：

1. **Lasso Mode 状态丢失**：虽然 `SelectionStore` 定义了 `lassoMode` 字段，但在实际操作中，**从未调用过更新状态的 Action**。因此，`lassoMode` 始终保持默认值 `'freehand'`。
2. **错误的平滑决策**：由于状态总是 `freehand`，`pathToMask` 只要检测到点数足够多（多边形选区点数也可能超过 20），就会错误地应用平滑算法。
3. **混合模式检测不足**：原始代码仅基于当前的 Alt 键状态判断模式，没有记录“整个选区创建过程是否包含拖拽”。

## 4. 最终解决方案 (Final Solution)

###Store 更新
在 `selection.ts` 中添加并实现了 `setLassoMode` action。

### 逻辑优化 (`useSelectionHandler.ts`)

引入了对 **"纯多边形意图" (Pure Polygonal Intent)** 的追踪：

1. **追踪**：引入 `isPurePolygonalRef`。如果在创建过程中发生任何**拖拽**行为（超过阈值），将其标记为 `false`。
2. **提交**：在选区提交（Commit）时，根据追踪结果设置最终的 `lassoMode`：
   - **纯点击 (Alt+Click)** → `setLassoMode('polygonal')` → `pathToMask` 保留尖角。
   - **包含拖拽 (Freehand)** → `setLassoMode('freehand')` → `pathToMask` 应用平滑。
3. **代码清理**：重构了路径平滑工具函数，提升了代码可读性。

## 5. 结论

通过正确管理选区模式状态，并智能区分用户的操作意图（点击 vs 拖拽），我们成功实现了：

- 自由手绘选区的平滑抗锯齿。
- 多边形选区的精确锐利尖角。
- 笔刷绘图与选区边缘的完美融合。

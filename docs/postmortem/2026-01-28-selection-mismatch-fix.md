# 选区填充不贴合问题修复 (Selection Mismatch Fix)

**日期**: 2026-01-28
**状态**: 已修复
**模块**: 选区系统 (Selection System)

## 问题描述

用户反馈在使用多边形套索工具（Polygonal Lasso）创建选区并填充时，填充区域比蚂蚁线（Marching Ants）轮廓“内缩”且尖角被圆润化。

![Issue](C:/Users/LiuYang/.gemini/antigravity/brain/a901597e-74a9-4895-8506-586449c33548/uploaded_media_1769601147660.png)

## 根因分析 (Root Cause)

经过代码审查，发现蚂蚁线渲染与 Mask 生成使用了分离的路径源，导致了 **View (视觉反馈) 与 Model (数据真值)** 的不一致。

| 组件            | 路径来源                         | 处理逻辑                           | 结果                     |
| --------------- | -------------------------------- | ---------------------------------- | ------------------------ |
| **蚂蚁线**      | `selectionPath` (存储原始点击点) | `ctx.lineTo` 直接连接              | 始终锐利，保留原始顶点   |
| **Mask (填充)** | `pathToMask` (使用原始点生成)    | **应用了平滑算法** (RDP + Chaikin) | 边缘被圆滑处理，尖角收缩 |

当 `lassoMode` 被判定为 `freehand` 时（或即使用户认为是 polygonal 但系统判定为 freehand），Mask 会被平滑。此时：

- 蚂蚁线显示：**锐利多边形**（因为直接连线了原始点）
- 实际 Mask：**圆角多边形**（因为内部做了平滑）
- **差异**：填充区域（基于 Mask）看起来就比蚂蚁线（基于原始点）要小一圈。

## 解决方案 (Solution)

**统一真值来源**：确保蚂蚁线所展示的路径与 Mask 的实际边界严格一致。

修改 `src/stores/selection.ts` 中的 `commitSelection` 逻辑：

```typescript
// Before
finalPath = [path]; // 直接使用原始创建点作为蚂蚁线路径

// After
finalPath = traceMaskToPaths(finalMask); // 从生成的 Mask 反向追踪出轮廓路径
```

通过这一修改，无论 `pathToMask` 内部如何处理（平滑、羽化或后续的任何算法调整），`selectionPath` 都会忠实地反映 Mask 的最终形状。

## 验证结果

- **此时**：如果系统应用了平滑，蚂蚁线也会显示为平滑圆角，用户能所见即所得。
- **一致性**：填充区域将完美贴合蚂蚁线边界。

## 后续建议

如果用户后续反馈“多边形模式不应该有圆角”，则问题将收敛为**“为什么 Lasso Mode 状态判定错误”**，而非“填充为什么不贴合”。届时需排查 `useSelectionHandler` 中的 `isPurePolygonalRef` 状态管理逻辑。

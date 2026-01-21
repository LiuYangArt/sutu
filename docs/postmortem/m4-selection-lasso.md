# M4 选区工具和套索工具开发 Postmortem

**日期**: 2025-01-21
**功能**: M4 选区系统 - 矩形选区 + Lasso 套索工具
**状态**: 已完成核心功能

## 概述

为 PaintBoard 实现了 Photoshop 风格的选区系统，包含矩形选区工具和套索工具，支持蚂蚁线动画和混合选区模式。

## 实现的功能

| 功能 | 状态 | 说明 |
|------|------|------|
| 矩形选区 (M) | ✅ | 拖拽创建矩形选区 |
| 套索工具 (S) | ✅ | Freehand 自由绘制 + Alt 切换 Polygonal 模式 |
| 蚂蚁线动画 | ✅ | 独立 Overlay Canvas 渲染 |
| 快捷键 | ✅ | M/S 工具切换, Ctrl+A/D 全选/取消 |
| Alt 混合模式 | ✅ | 选区过程中实时切换 freehand/polygonal |

## 遇到的问题和解决方案

### 问题 1: 更新了错误的组件文件

**症状**: Lasso 工具栏按钮不显示

**根因**: 项目有两个工具栏组件：
- `src/components/ToolsPanel/index.tsx` - 未被使用
- `src/components/SidePanel/LeftToolbar.tsx` - 实际使用的组件

我只更新了前者，导致按钮不显示。

**解决**: 更新正确的文件 `LeftToolbar.tsx`

**教训**:
- 修改 UI 组件前，先确认哪个组件实际被渲染
- 使用 `grep` 或组件层级信息确认实际使用的组件

---

### 问题 2: Alt 键全局切换吸色工具

**症状**: 在 Lasso 工具下按 Alt 会跳转到吸色工具，而不是切换到 polygonal 模式

**根因**: `Canvas/index.tsx` 中的 Alt 键处理是全局的，没有区分当前工具

**解决**:
```typescript
// 修改前：全局生效
if (!altPressed) { setTool('eyedropper'); }

// 修改后：仅对画笔/橡皮擦生效
if (!altPressed && (currentTool === 'brush' || currentTool === 'eraser')) {
  setTool('eyedropper');
}
```

**教训**: 添加新工具时，检查现有快捷键处理是否会冲突

---

### 问题 3: Lasso Alt 模式切换行为不符合 Photoshop

**症状**:
- 需要先点击才能继续 polygonal 选择
- 不能在选区过程中实时混合两种模式

**根因**: 原设计使用 `lassoMode` 状态切换，不支持实时混合

**解决**:
1. 移除 `lassoMode` store 状态
2. 改为根据 `e.altKey` 实时判断当前模式
3. Alt 按下时自动在当前鼠标位置锚定顶点

```typescript
// Alt 按下时自动锚定当前位置
if (currentTool === 'lasso' && isSelectingRef.current && lastPointRef.current) {
  addCreationPoint(lastPointRef.current);
}
```

**教训**:
- 参考原软件行为时，先完整测试各种交互场景
- 实时状态（如按键）不应存储在 store 中，应使用事件属性

---

### 问题 4: 蚂蚁线动画速度过快

**症状**: 60fps 下蚂蚁线移动太快，视觉不舒适

**根因**: 每帧增量 0.5 过大

**解决**: 降低到 0.15
```typescript
marchingAntsOffset: (state.marchingAntsOffset + 0.15) % 8
```

**教训**: 动画参数需要实际测试调整

---

## 代码简化

实现后进行了代码简化，移除了以下未使用代码：

1. `justEnteredPolygonalRef` - 未使用的 ref
2. `setLassoMode` / `toggleLassoMode` - 未使用的 store 方法（Alt 模式改为实时检测）

减少约 15 行代码。

## 架构决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 选区渲染 | 独立 Overlay Canvas | 避免每帧重绘主画布 |
| 蒙版表示 | ImageData 位图 | 支持羽化效果，兼容复杂路径 |
| Alt 模式检测 | 实时 `e.altKey` | 支持混合模式，无需存储状态 |

## 待完成

- [ ] Phase 4: 选区限制绘画集成（在笔刷渲染管线中检查蒙版）
- [ ] 布尔运算（Shift 加选，Alt 减选）
- [ ] 羽化/扩展/收缩操作

## 文件清单

新增：
- `src/stores/selection.ts` - 选区状态管理
- `src/components/Canvas/useSelectionHandler.ts` - 选区交互 Hook
- `src/components/Canvas/SelectionOverlay.tsx` - 蚂蚁线渲染

修改：
- `src/components/SidePanel/LeftToolbar.tsx` - 添加 Lasso 图标
- `src/components/ToolsPanel/index.tsx` - 添加 Lasso 图标（备用）
- `src/components/Canvas/index.tsx` - 集成选区交互和快捷键

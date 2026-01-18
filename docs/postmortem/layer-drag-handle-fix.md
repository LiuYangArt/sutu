# Layer Drag Handle Fix

**Date**: 2026-01-18
**Issue**: #77 - 绘图基础功能

## Problem

图层拖拽功能失效：限制只能从 handle 拖拽后，无法拖动图层排序。

## Root Cause

HTML5 拖拽事件的 `e.target` 指向的是设置了 `draggable` 属性的元素本身，而不是用户实际点击的元素。

### 错误代码

```tsx
onDragStart={(e) => {
  const target = e.target as HTMLElement;
  // ❌ e.target 是 layer-item，不是用户点击的 handle
  if (!target.closest('.drag-handle')) {
    e.preventDefault();
    return;
  }
  onDragStart(e, layer.id);
}}
```

**问题**：
- 用户点击 `.drag-handle` 内的图标
- 浏览器触发 `dragstart` 事件
- `e.target` 是 `layer-item` div（因为它是 `draggable` 元素）
- `target.closest('.drag-handle')` 返回 `null`
- 拖拽被错误地阻止

## Solution

使用 `mousedown` 事件记录用户实际点击位置，在 `dragstart` 中检查这个记录：

```tsx
const dragFromHandleRef = useRef(false);

// mousedown 捕获真实点击位置
onMouseDown={(e) => {
  const target = e.target as HTMLElement;
  dragFromHandleRef.current = !!target.closest('.drag-handle');
}}

// dragstart 检查记录的位置
onDragStart={(e) => {
  if (!dragFromHandleRef.current) {
    e.preventDefault();
    return;
  }
  onDragStart(e, layer.id);
}}
```

## Key Insight

**HTML5 Drag and Drop 事件的 `e.target`**：
- `dragstart` 的 `e.target` 是 `draggable` 元素本身
- 不是触发拖拽的实际点击元素
- 需要在 `mousedown` 阶段捕获真实点击位置

## Additional Fix

移除了 `.drag-handle` 元素的 `draggable={false}` 属性，该属性会阻止拖拽事件冒泡。

## Files Changed

- `src/components/LayerPanel/index.tsx`
  - 添加 `useRef` 导入
  - 添加 `onMouseDown` 事件处理
  - 修改 `onDragStart` 逻辑

## Prevention

当限制拖拽触发区域时：
1. 使用 `mousedown` 记录点击位置
2. 在 `dragstart` 中检查记录
3. 避免在子元素上设置 `draggable={false}`

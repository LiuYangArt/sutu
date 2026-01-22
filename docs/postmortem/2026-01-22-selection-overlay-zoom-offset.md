# Selection Overlay Zoom Offset - Canvas 缓冲区与显示尺寸不匹配

**日期**: 2026-01-22
**状态**: ✅ 已解决
**影响**: 选区蚂蚁线随画布 zoom 缩放时发生位置偏移

## 问题描述

选区蚂蚁线会随画布 zoom 的缩放进行偏移：
- **缩小时**: 选区向上偏移
- **放大时**: 选区向下偏移

正确的行为应该是选区固定在画布对应的位置，不随 zoom 变化。

## 根因分析

### 问题定位过程

1. **初步假设错误**: 一开始怀疑是 Canvas 2D 的 `translate` + `scale` 变换顺序问题
2. **深入分析布局结构**: 发现 SelectionOverlay 的 canvas 定位是正确的
3. **发现真正问题**: Canvas 像素缓冲区尺寸与 CSS 显示尺寸不匹配

### 根本原因

`SelectionOverlay.tsx` 中 Canvas 的像素缓冲区尺寸使用 `window.innerWidth/Height`，而 CSS 显示尺寸使用 `100%`（容器大小）：

```typescript
// 像素缓冲区尺寸 = 窗口大小
const containerWidth = window.innerWidth;   // 例如 1920
const containerHeight = window.innerHeight; // 例如 1080

// CSS 显示尺寸 = 容器大小（比窗口小，因为上面有 Toolbar）
style={{
  width: '100%',   // 例如实际 1920
  height: '100%',  // 例如实际 1040（减去 Toolbar 40px）
}}
```

**不匹配导致**：Canvas 内容被拉伸/压缩显示。当 zoom 变化时，这个拉伸比例会放大误差：
- 缩小时 (scale < 1): 选区向上偏移
- 放大时 (scale > 1): 选区向下偏移

### 布局结构

```
.app
└── Toolbar (固定高度，例如 40px)
└── .workspace (flex: 1)
    └── .canvas-container (position: relative, flex: 1)
        ├── .canvas-checkerboard
        ├── SelectionOverlay (position: absolute, 100% x 100%)
        └── .canvas-viewport (CSS transform: translate + scale)
            └── main-canvas
```

关键点：SelectionOverlay 的 CSS `height: 100%` 是相对于 `.canvas-container` 的，而不是整个窗口。

## 解决方案

使用 `ResizeObserver` 动态获取 Canvas 元素的实际显示尺寸，确保像素缓冲区与显示尺寸 1:1 匹配：

```typescript
const [canvasSize, setCanvasSize] = useState({ width: 1920, height: 1080 });

useEffect(() => {
  const canvas = canvasRef.current;
  if (!canvas) return;

  const updateSize = () => {
    const rect = canvas.getBoundingClientRect();
    setCanvasSize({
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
  };

  updateSize();
  const resizeObserver = new ResizeObserver(updateSize);
  resizeObserver.observe(canvas);
  return () => resizeObserver.disconnect();
}, []);

// Canvas 使用动态尺寸
<canvas width={canvasSize.width} height={canvasSize.height} ... />
```

## 教训总结

### 1. Canvas 尺寸匹配原则

**Canvas 的 `width/height` 属性（像素缓冲区）必须与 CSS 显示尺寸匹配**，否则内容会被拉伸或压缩。

常见错误模式：
```typescript
// ❌ 错误：假设 canvas 占满整个窗口
width={window.innerWidth}
height={window.innerHeight}
style={{ width: '100%', height: '100%' }}

// ✅ 正确：使用 ResizeObserver 获取实际尺寸
width={actualContainerWidth}
height={actualContainerHeight}
style={{ width: '100%', height: '100%' }}
```

### 2. 调试坐标偏移问题的思路

当遇到"随 zoom 变化的偏移"问题时，检查顺序：
1. **坐标变换链** - transform 顺序是否正确
2. **尺寸匹配** - 像素缓冲区 vs 显示尺寸是否一致
3. **容器定位** - position: absolute 相对于哪个元素

### 3. 第一性原理分析

不要急于修改代码。先完整理解：
1. 布局结构（HTML/CSS）
2. 坐标系统（screen → container → document）
3. 变换链路（CSS transform vs Canvas 2D transform）

## 修改的文件

- `src/components/Canvas/SelectionOverlay.tsx`
  - 添加 `useState` 跟踪 canvas 尺寸
  - 添加 `ResizeObserver` 动态更新尺寸
  - 移除未使用的 `width/height` props
- `src/components/Canvas/index.tsx`
  - 移除传递给 SelectionOverlay 的 `width/height` props

## 相关问题

- `2026-01-22-selection-mask-clipping.md` - 选区 mask 裁切的坐标偏移问题（不同问题，但根因类似：坐标系统不匹配）

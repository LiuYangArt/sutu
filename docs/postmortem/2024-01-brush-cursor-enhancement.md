# Postmortem: 笔刷 Cursor 增强功能

**日期**: 2024-01
**功能**: ABR 纹理笔刷 cursor 轮廓显示 + Roundness/Angle 响应
**状态**: 已完成

## 需求背景

1. ABR 纹理笔刷导入后，cursor 仍显示圆形，需要显示纹理的实际轮廓形状
2. 修改 roundness 参数时，圆头和纹理笔刷的 cursor 形状需要对应变化

## 技术方案

### 核心思路：预生成 + 按需变换

轮廓在 ABR 导入时一次性提取并存储为 SVG path，运行时通过 `transform` 高效应用 roundness/angle 变换。

```
ABR 导入 → 提取轮廓 (边界追踪) → 简化为 SVG Path → 存储到 BrushPreset.cursorPath
                                                              ↓
运行时 → 读取 cursorPath → 应用 scaleY(roundness) + rotate(angle) → 输出 SVG cursor
```

### 修改的文件

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src-tauri/src/abr/cursor.rs` | **新增** | 边界追踪 + RDP 简化算法 |
| `src-tauri/src/abr/types.rs` | 修改 | `BrushPreset` 添加 `cursor_path`, `cursor_bounds` |
| `src/components/Canvas/useCursor.ts` | 修改 | 硬件 cursor 支持纹理 path + roundness/angle |
| `src/components/Canvas/index.tsx` | 修改 | DOM cursor 支持纹理 path |
| `src/stores/tool.ts` | 修改 | `BrushTexture` 添加 cursor 字段 |
| `src/components/BrushPanel/types.ts` | 修改 | 前端 `BrushPreset` 类型扩展 |

## 遇到的问题与解决

### 问题 1: Marching Squares 算法实现失败

**现象**: 单元测试失败，无法从简单图形提取轮廓

**原因**: 原始 Marching Squares 实现的方向追踪逻辑有 bug，无法正确闭合轮廓

**解决**: 改用更简单的边界追踪算法：
1. `find_boundary_pixels` - 扫描所有边界像素
2. `order_boundary_pixels` - 最近邻链接排序
3. `rdp_simplify` - RDP 算法简化路径

**教训**: 复杂算法不一定比简单算法更好，边界追踪 + 最近邻排序足够满足需求

### 问题 2: SVG Path 归一化坐标偏移

**现象**: cursor 显示位置偏向左上角，笔刷越大偏移越明显

**原因**:
```rust
// 错误的归一化
let nx = (x / max_dim) - 0.5;

// 正确的归一化（先减去中心点）
let nx = (x - center_x) / max_dim;
```

**解决**: 修改 `normalize_to_svg_path` 函数，先将坐标相对于图像中心偏移，再归一化

**教训**: 归一化时要明确"中心点"的定义，确保 path 真正居中于原点 (0, 0)

### 问题 3: 128px 以上笔刷显示圆形

**现象**: 小笔刷 (<128px) 正确显示纹理轮廓，大笔刷仍显示圆形

**原因**: 128px 以上使用 DOM cursor（软件 cursor），但 DOM cursor 代码没有更新

**解决**: 在 `index.tsx` 的 DOM cursor 中添加 SVG 内联渲染

**教训**: 硬件 cursor 和软件 cursor 是两套独立逻辑，修改时需要同步更新

### 问题 4: DOM cursor 的纹理轮廓不显示

**现象**: 大笔刷 cursor 什么都不显示

**原因**:
1. CSS `.brush-cursor` 的 `border-radius: 50%` 和 `box-shadow` 覆盖了 SVG
2. 只设置 `borderColor: 'transparent'` 不够

**解决**: 完全覆盖圆形相关的 CSS 属性：
```tsx
...(brushTexture?.cursorPath && {
  border: 'none',
  borderRadius: 0,
  boxShadow: 'none',
})
```

**教训**: 内联样式需要完全覆盖 CSS 类的所有相关属性，不能只改部分

### 问题 5: 硬件 cursor 的纹理轮廓太小

**现象**: 64px 以下的笔刷 cursor 只显示一个小点

**原因**: 缩放计算错误
```typescript
// 错误：bounds.width 是原始纹理像素尺寸（如 100px）
const pathScale = screenBrushSize / Math.max(bounds.width, bounds.height);

// 正确：path 已归一化到单位尺寸，直接按目标尺寸缩放
const pathScale = screenBrushSize;
```

**解决**: 由于 path 已归一化到 -0.5 ~ 0.5 范围（总宽度为 1），直接用 `screenBrushSize` 作为缩放系数

**教训**: 归一化坐标系的缩放要与归一化方式匹配

## 代码简化

最终提取了共享函数减少重复：

```typescript
// 纹理笔刷轮廓生成
export function generateTextureOutlineSvg(cursorPath, size, scaleY, angle, stroke)

// 椭圆笔刷轮廓生成
export function generateEllipseOutlineSvg(rx, ry, angle, stroke)
```

描边样式集中配置：
```typescript
const DEFAULT_STROKE: StrokeStyle = {
  outer: { color: 'rgba(255,255,255,0.9)', width: 1.5 },
  inner: { color: 'rgba(0,0,0,0.8)', width: 1 },
};
```

## 关键设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 轮廓提取时机 | 导入时 | 一次提取多次使用，避免运行时开销 |
| 存储格式 | SVG path string | 体积小，缩放无损，浏览器原生支持 |
| 轮廓算法 | 边界追踪 + RDP | 比 Marching Squares 更简单可靠 |
| Roundness 实现 | SVG/CSS transform | 无需重新计算轮廓，GPU 加速 |

## 验证清单

- [x] 圆头笔刷 roundness slider → cursor 实时变为椭圆
- [x] 圆头笔刷 angle slider → cursor 实时旋转
- [x] 导入 ABR 文件 → 纹理笔刷显示轮廓 cursor
- [x] 小笔刷 (<128px) 硬件 cursor 正确显示
- [x] 大笔刷 (>128px) DOM cursor 正确显示
- [x] cursor 中心与笔画中心对齐（无偏移）
- [x] Rust 单元测试全部通过

## 后续优化问题与解决 (2024-01 续)

### 问题 6: DOM cursor 容器 transform 覆盖位置

**现象**: 纹理笔刷的 DOM cursor (>128px) 初始显示在左上角，鼠标移动后才归位

**原因**: 在 `index.tsx` 中设置了 `transform: rotate(${brushAngle}deg)`，这会**覆盖**掉 `useCursor.ts` 中通过 JS 设置的 `translate(X, Y)` 位置变换

```tsx
// 错误：容器上同时设置 rotation，覆盖了位置 transform
style={{
  transform: `rotate(${brushAngle}deg)`,  // 覆盖了 useCursor 设置的 translate!
}}
```

**解决**: 将 rotation 移到内部元素（SVG 或 ellipse div）上，不影响容器的位置 transform

```tsx
// 正确：容器只负责位置，内部元素负责旋转
<div ref={brushCursorRef} className="brush-cursor">
  <svg style={{ transform: `rotate(${brushAngle}deg)` }}>
    ...
  </svg>
</div>
```

**教训**: CSS transform 是整体覆盖而非叠加，需要分离不同层级的变换职责

### 问题 7: 键盘缩放笔刷时 cursor 飞到左上角

**现象**: 用 `]` 键放大笔刷超过 128px 时，cursor 瞬间飞到左上角

**原因**:
1. `showDomCursor` 从 `false` 变为 `true`
2. DOM cursor 元素**新创建**，但没有收到任何 pointer 事件
3. 没有初始位置，默认显示在 CSS 的 `left: 0; top: 0`

**解决**: 添加 `lastMousePosRef` 持续追踪鼠标位置，并在 `showDomCursor` 变为 `true` 时初始化位置

```typescript
const lastMousePosRef = useRef<{ x: number; y: number } | null>(null);

// 始终追踪鼠标位置
const handleNativePointerMove = (e: PointerEvent) => {
  lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  // ...
};

// DOM cursor 显示时初始化位置
useEffect(() => {
  if (showDomCursor && cursor && lastPos) {
    setCursorPosition(cursor, lastPos.x, lastPos.y);
  }
}, [showDomCursor]);
```

**教训**: 状态驱动的 UI 元素创建时，需要考虑初始状态的设置，不能完全依赖事件驱动

### 问题 8: 硬件/DOM cursor 切换时 crosshair 闪烁

**现象**: 缩放笔刷穿过 128px 阈值时，短暂显示 crosshair

**原因**: `cursorStyle` 判断逻辑中，`showDomCursor` 的优先级低于 `showCrosshair`

```typescript
// 错误：showDomCursor 时仍然可能进入 crosshair 分支
} else if (showCrosshair && (currentTool === 'brush' || currentTool === 'eraser')) {
  cursorStyle = 'crosshair';
}
```

**解决**: 调整优先级，`showDomCursor` 时直接设置 `cursorStyle = 'none'`

```typescript
// 正确：showDomCursor 优先级高于 crosshair
} else if (showDomCursor) {
  cursorStyle = 'none';  // DOM cursor 负责显示，系统 cursor 隐藏
} else if (showCrosshair && ...) {
  cursorStyle = 'crosshair';
}
```

**教训**: 状态切换时的优先级顺序很重要，需要确保互斥状态不会同时生效

### 问题 9: 轮廓线粗细随笔刷缩放

**现象**: 笔刷越大，cursor 轮廓线越粗

**原因**:
1. 硬件 cursor: `strokeWidth` 被动态计算 `Math.max(1.5 / size, 0.02)`
2. DOM cursor: `strokeWidth="0.025"` 是归一化值，随 viewBox 缩放

**解决**: 使用 SVG 的 `vector-effect="non-scaling-stroke"` 属性

```tsx
<path
  strokeWidth={1.5}
  vectorEffect="non-scaling-stroke"  // 保持固定像素宽度
/>
```

**教训**: SVG 有专门的属性处理"不随缩放变化的描边"，不需要手动计算

## 代码简化 (续)

本次新增辅助函数进一步减少重复：

```typescript
/** Set cursor position with center offset */
const setCursorPosition = (cursor: HTMLDivElement, x: number, y: number) => {
  cursor.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
};

/** Generate crosshair SVG lines */
const generateCrosshairSvg = (cx: number, cy: number, size: number) => `...`;
```

移除未使用的 `export`：
- `generateTextureOutlineSvg` 改为内部函数
- `generateEllipseOutlineSvg` 改为内部函数

## 相关文档

- **轮廓优化方案**: `docs/todo/abr-cursor-outline-optimization.md`
  - Marching Squares 算法方案
  - Chaikin 平滑算法
  - 待后续实现

## 后续优化问题与解决 (2025-01 续)

### 问题 10: 键盘缩放笔刷时 cursor 在过渡尺寸区间消失或显示 crosshair

**现象**: 用 `[` `]` 键调整笔刷大小时，在某个尺寸区间内 cursor 会变成 crosshair，或完全消失

**第一性原理分析**:

硬件 cursor 和 DOM cursor 的切换逻辑：
```typescript
// 硬件 cursor: screenBrushSize <= 128
const shouldUseHardwareCursor = screenBrushSize <= 128 && ...;

// DOM cursor: !shouldUseHardwareCursor (即 screenBrushSize > 128)
const showDomCursor = !shouldUseHardwareCursor && ...;
```

理论上这是互补的，不应该有间隙。

**根因 1: Windows 硬件 cursor 尺寸限制**

Windows 系统对硬件 cursor 有尺寸限制（标准 32x32，部分系统支持到 128x128）。当 `screenBrushSize` 处于某个范围时：
1. 代码认为 `shouldUseHardwareCursor = true`
2. **Windows 实际上拒绝显示超尺寸的 cursor**（静默失败）
3. 同时 `showDomCursor = false`
4. 结果：cursor 完全消失

**根因 2: CSS cursor fallback 机制**

```typescript
return `url("${cursorUrl}") ${center} ${center}, crosshair`;
//                                              ^^^^^^^^^^^
```

当 SVG data URL 解析过程中，浏览器会使用 fallback cursor（`crosshair`），导致闪烁。

**解决**:

1. 将硬件 cursor 阈值从 128px 降到 96px（保守安全值）：
```typescript
const HARDWARE_CURSOR_MAX_SIZE = 96;
const shouldUseHardwareCursor =
  isBrushTool && screenBrushSize <= HARDWARE_CURSOR_MAX_SIZE && !isInteracting;
```

2. 将 CSS cursor fallback 从 `crosshair` 改为 `none`：
```typescript
return `url("${cursorUrl}") ${center} ${center}, none`;
```

**教训**:
- 浏览器/系统对硬件 cursor 有隐式限制，超过限制时会静默失败而非报错
- CSS cursor 的 fallback 值会在图片加载期间显示，需要选择合适的 fallback
- 从第一性原理分析问题时，要考虑"代码逻辑"之外的"运行时环境限制"

### 代码简化 (2025-01)

提取公共变量减少重复判断：

```typescript
// 之前：重复 4 次
currentTool === 'brush' || currentTool === 'eraser'
spacePressed || isPanning

// 之后：提取为变量
const isBrushTool = currentTool === 'brush' || currentTool === 'eraser';
const isInteracting = spacePressed || isPanning;

// 简化后的条件判断
const shouldUseHardwareCursor =
  isBrushTool && screenBrushSize <= HARDWARE_CURSOR_MAX_SIZE && !isInteracting;
const showDomCursor = isBrushTool && !isInteracting && !shouldUseHardwareCursor;
```

代码行数：283 → 269 行（-14 行）

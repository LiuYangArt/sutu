# Shift 直线绘制模式设计

## 背景

实现类似 Photoshop 的 **Shift 直线绘制** 功能，允许用户按住 Shift 键沿辅助线绘制直线笔触。

## 需求总结

| 项目                | 描述                                                        |
| ------------------- | ----------------------------------------------------------- |
| **锚点**            | `endStroke` 时记录最后一个 dab 位置；无锚点时用当前光标位置 |
| **Shift 辅助线**    | 按住 Shift 显示辅助线（锚点 → 光标），落笔后锁定            |
| **Ctrl+Shift 吸附** | 辅助线吸附到 8 方向（0°/45°/90°/135°/180°/225°/270°/315°）  |
| **绘制约束**        | dab 沿锁定线段绘制，clamp 在起止点范围内                    |
| **辅助线样式**      | 细实线，黑色带白色描边（双线确保可见性）                    |
| **释放**            | 松开 modifier key 解除直线模式                              |

---

## Proposed Changes

### 1. 新建 Hook: `useShiftLineMode`

#### [NEW] [useShiftLineMode.ts](file:///f:/CodeProjects/PaintBoard/src/components/Canvas/useShiftLineMode.ts)

负责直线模式的状态管理和计算逻辑：

```typescript
interface ShiftLineModeState {
  // 锚点（上次笔划最后一个 dab 的位置）
  anchorPoint: { x: number; y: number } | null;

  // 辅助线是否已锁定（落笔后锁定）
  isLineLocked: boolean;

  // 锁定的线段终点（落笔位置）
  lockedEndPoint: { x: number; y: number } | null;

  // 当前 modifier 状态
  shiftPressed: boolean;
  ctrlPressed: boolean;
}

interface UseShiftLineModeResult {
  // 状态
  anchorPoint: Point | null;
  isLineMode: boolean; // shiftPressed && anchorPoint !== null
  isSnapMode: boolean; // ctrlPressed && isLineMode

  // 计算后的辅助线端点（考虑 snap）
  guideLine: { start: Point; end: Point } | null;

  // 坐标约束：将输入点投影到辅助线上
  constrainPoint: (x: number, y: number) => { x: number; y: number };

  // 生命周期
  onStrokeEnd: (lastDabPos: { x: number; y: number }) => void;
  onStrokeStart: (startPos: { x: number; y: number }) => void;
  lockLine: (endPoint: { x: number; y: number }) => void;
  unlockLine: () => void;
}
```

**核心逻辑**:

1. **锚点管理**: `endStroke` 调用 `onStrokeEnd(lastDabPos)` 更新锚点
2. **角度吸附**: `snapToGrid(angle)` 将角度吸附到最近的 45° 倍数
3. **点投影**: `constrainPoint()` 将输入点投影到线段上，并 clamp 到起止点范围

---

### 2. 修改辅助线渲染

#### [MODIFY] [Canvas/index.tsx](file:///f:/CodeProjects/PaintBoard/src/components/Canvas/index.tsx)

在 `compositeAndRenderWithPreview` 之后绘制辅助线：

```typescript
// 使用新 Hook
const { guideLine, isLineMode, constrainPoint, onStrokeEnd, lockLine, unlockLine } =
  useShiftLineMode();

// 辅助线绘制（在 composite 后）
const renderGuideLine = useCallback(() => {
  if (!guideLine || !isLineMode) return;

  const ctx = canvasRef.current?.getContext('2d');
  if (!ctx) return;

  ctx.save();

  // 白色描边（底层）
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(guideLine.start.x * scale, guideLine.start.y * scale);
  ctx.lineTo(guideLine.end.x * scale, guideLine.end.y * scale);
  ctx.stroke();

  // 黑色实线（上层）
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(guideLine.start.x * scale, guideLine.start.y * scale);
  ctx.lineTo(guideLine.end.x * scale, guideLine.end.y * scale);
  ctx.stroke();

  ctx.restore();
}, [guideLine, isLineMode, scale]);
```

---

### 3. 修改事件处理

#### [MODIFY] [Canvas/index.tsx](file:///f:/CodeProjects/PaintBoard/src/components/Canvas/index.tsx)

**handlePointerDown**:

- 如果 `isLineMode`，调用 `lockLine(clickPos)` 锁定辅助线

**handlePointerMove / processPoint**:

- 如果辅助线已锁定，调用 `constrainPoint()` 约束坐标：

```typescript
// 在 processSinglePoint 或 inputQueue 入队前
if (isLineLocked) {
  const constrained = constrainPoint(canvasX, canvasY);
  canvasX = constrained.x;
  canvasY = constrained.y;
}
```

**handlePointerUp / finishCurrentStroke**:

- 调用 `onStrokeEnd(lastDabPosition)` 更新锚点

**keydown/keyup**:

- 监听 Shift/Ctrl 键，更新状态
- `keyup` 调用 `unlockLine()` 解除锁定

---

### 4. 获取最后一个 dab 位置

#### [MODIFY] [useBrushRenderer.ts](file:///f:/CodeProjects/PaintBoard/src/components/Canvas/useBrushRenderer.ts)

添加 `getLastDabPosition()` 方法：

```typescript
// 在 useBrushRenderer 中追踪最后一个 dab
const lastDabPosRef = useRef<{ x: number; y: number } | null>(null);

// processPoint 中更新
lastDabPosRef.current = { x: pos.x, y: pos.y };

// 导出 getter
const getLastDabPosition = useCallback(() => lastDabPosRef.current, []);
```

---

## 数据流

```
┌──────────────────────────────────────────────────────────────┐
│                       用户交互流程                            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  1. 普通绘制结束                                              │
│     └─→ endStroke() → onStrokeEnd(lastDab) → 更新 anchorPoint │
│                                                              │
│  2. 按住 Shift                                               │
│     └─→ 显示辅助线 (anchorPoint → cursor)                    │
│         └─→ 如果按住 Ctrl，snap 到 8 方向                     │
│                                                              │
│  3. Shift + 落笔                                             │
│     └─→ lockLine(clickPos) → 锁定辅助线方向                  │
│                                                              │
│  4. 拖拽绘制                                                  │
│     └─→ constrainPoint(input) → 投影到线段                   │
│         └─→ clamp 到起止点范围                                │
│                                                              │
│  5. 松开 Shift                                               │
│     └─→ unlockLine() → 解除锁定，恢复自由绘制                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Verification Plan

### Automated Tests

新建 `useShiftLineMode.test.ts`:

1. **锚点更新测试**: `onStrokeEnd` 后 `anchorPoint` 正确更新
2. **角度吸附测试**: 验证 8 方向吸附的边界条件
3. **点投影测试**: `constrainPoint()` 正确投影到线段并 clamp
4. **无锚点降级测试**: 初始状态下 `isLineMode` 为 false

### Manual Verification

1. 画一笔，松开，再次画直线时辅助线起点应该是上一笔最后一个 dab 的位置（而非起点）
2. 按住 Shift 拖动光标，辅助线应该跟随
3. 按住 Ctrl+Shift，辅助线应该吸附到 8 方向
4. Shift 落笔后拖拽，笔触应该只在辅助线上绘制
5. 松开 Shift，恢复自由绘制

---

## 风险评估

| 风险                      | 影响 | 缓解措施                             |
| ------------------------- | ---- | ------------------------------------ |
| 辅助线渲染闪烁            | 低   | 与 composite 同步渲染，避免单独 RAF  |
| 坐标约束影响压感          | 低   | 只约束 x/y，保留原始 pressure        |
| 与现有 Selection 工具冲突 | 中   | Shift 模式仅在 brush/eraser 工具激活 |

---

## 实施顺序

1. 创建 `useShiftLineMode` hook，实现核心逻辑
2. 添加 `getLastDabPosition` 到 `useBrushRenderer`
3. 集成到 `Canvas/index.tsx`：事件处理 + 辅助线渲染
4. 编写单元测试
5. 手动验证

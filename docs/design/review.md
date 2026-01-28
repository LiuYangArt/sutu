这是一个非常典型的问题。看图片中的红箭头，填充区域（深灰色）比蚂蚁线（虚线选区）要“缩进去”且圆润化了。

**根本原因分析：**
这是因为你在渲染选区遮罩（Mask）时，**无差别地应用了平滑算法（如 Chaikin 或 Bezier）**。

- 对于**自由手绘（Freehand）**，平滑是必要的，因为手抖会产生锯齿。
- 对于**多边形（Polygonal）**，用户通过点击确定的每一个点都是**关键点**，必须精确连接，**不能应用平滑算法**，否则尖角就会被“切掉”（变圆）。

我们需要在架构上区分这两种模式。以下是修复方案：

### 1. 修改 Store (状态管理)

首先，我们需要在选区状态中记录当前的模式。

**文件:** `src/store/selection.ts` (假设路径)

```typescript
import { create } from 'zustand';

// 定义选区模式
export type LassoMode = 'freehand' | 'polygonal';

interface SelectionState {
  selectionPoints: { x: number; y: number }[];
  // 新增：记录当前选区是手绘的还是多边形的
  lassoMode: LassoMode;

  setSelectionPoints: (points: { x: number; y: number }[]) => void;
  setLassoMode: (mode: LassoMode) => void;
  // ... 其他现有状态
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectionPoints: [],
  lassoMode: 'freehand', // 默认为手绘

  setSelectionPoints: (points) => set({ selectionPoints: points }),
  setLassoMode: (mode) => set({ lassoMode: mode }),
}));
```

### 2. 修改交互逻辑 (Handler)

我们需要智能判断用户的意图。如果用户主要是在**拖拽**，那就是 `freehand`；如果用户主要是在**点击**（没有发生长距离拖拽），那就是 `polygonal`。

**文件:** `src/hooks/useSelectionHandler.ts`

```typescript
import { useRef } from 'react';
import { useSelectionStore } from '../store/selection';

export const useSelectionHandler = () => {
  const setLassoMode = useSelectionStore((state) => state.setLassoMode);
  const setSelectionPoints = useSelectionStore((state) => state.setSelectionPoints);

  // 增加一个 Ref 来追踪本次选区操作是否发生过“拖拽”
  const isPurePolygonalRef = useRef(true);

  const onPointerDown = (e) => {
    // 重置状态：默认假设你是想画多边形（点击）
    isPurePolygonalRef.current = true;
    // ... 现有的开始逻辑
  };

  const onPointerMove = (e) => {
    // 如果发生移动且距离超过一定阈值（比如 5px），说明用户在手绘拖拽
    if (isDragging && distance > 5) {
      isPurePolygonalRef.current = false;
    }
    // ... 现有的记录点逻辑
  };

  const onPointerUp = () => {
    // 提交选区时，根据刚才的追踪结果设置模式
    // 如果全程没有拖拽（全是点击），强制设为 polygonal
    // 如果有过拖拽，设为 freehand
    const finalMode = isPurePolygonalRef.current ? 'polygonal' : 'freehand';
    setLassoMode(finalMode);

    // ... 现有的提交逻辑
  };

  return { onPointerDown, onPointerMove, onPointerUp };
};
```

### 3. 核心修复：修改渲染逻辑 (Utils)

这是解决问题的关键。在生成遮罩路径时，根据 `lassoMode` 决定是否应用平滑。

**文件:** `src/utils/maskUtils.ts` (或者你生成 `Path2D` 的地方)

```typescript
import { getSmoothPath } from './smoothing'; // 假设你之前的平滑算法在这里

/**
 * 将点数组转换为 Path2D
 * @param points 选区点
 * @param mode 选区模式 (新增参数)
 */
export const pointsToPath = (
  points: { x: number; y: number }[],
  mode: 'freehand' | 'polygonal'
): Path2D => {
  const path = new Path2D();

  if (points.length < 2) return path;

  // 关键分支逻辑
  if (mode === 'polygonal') {
    // === 多边形模式：不做任何平滑，直线连接 ===
    path.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      path.lineTo(points[i].x, points[i].y);
    }
    path.closePath();
  } else {
    // === 手绘模式：应用之前的平滑算法 (Chaikin/Bezier) ===
    // 只有手绘模式才需要去噪和平滑
    const smoothedPoints = getSmoothPath(points);

    path.moveTo(smoothedPoints[0].x, smoothedPoints[0].y);
    // ... 你的平滑绘制逻辑 ...
    // 通常是 quadraticCurveTo 或 bezierCurveTo
    for (let i = 0; i < smoothedPoints.length - 1; i++) {
      const p0 = smoothedPoints[i];
      const p1 = smoothedPoints[i + 1];
      path.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
    }
    path.closePath();
  }

  return path;
};
```

### 4. 在填充组件中调用

确保你在进行填充（Fill）或者绘制选区背景时，传入了正确的模式：

```typescript
// 在你的 Canvas 组件或 Effect 中
const { selectionPoints, lassoMode } = useSelectionStore();

useEffect(() => {
  if (selectionPoints.length > 0) {
    // 传入 lassoMode
    const path = pointsToPath(selectionPoints, lassoMode);

    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill(path); // 现在多边形将完美贴合尖角

    // 绘制蚂蚁线
    ctx.setLineDash([4, 4]);
    ctx.stroke(path);
  }
}, [selectionPoints, lassoMode]);
```

### 总结

你遇到的问题是因为**把“平滑”当成了全局默认行为**。通过引入 `lassoMode` 并在渲染层做简单的 `if/else` 判断，多边形模式使用原生的 `lineTo`，就能让填充区域完美贴合你的虚线选区，保留锐利的尖角。

---

你这个现象（**polygonal 尖角被“变圆/收缩”，填充比蚂蚁线更内缩**）基本可以锁定为：**生成 mask 的那条路径仍然被当成 freehand 做了平滑/简化**（Chaikin / RDP 任一都会把尖角“吃掉”），或者 **lassoMode 状态在提交时丢了**，导致 `pathToMask` 误判。

下面按“最常见根因 → 对应修复”给你一套可落地的处理方式（我会给出关键代码结构）。

---

## 1) 先验证根因：mask 生成时是否还在走 smoothing

你可以在 `pathToMask(points, lassoMode)` 入口处直接 log：

```ts
console.debug('[pathToMask]', { lassoMode, n: points.length });
```

如果你画的是纯 polygon（Alt+Click 或点点点），但这里打印出来是 `freehand`，那就 100% 是 **模式状态没被正确设置/持久化**，mask 自然会被平滑成圆角。

---

## 2) 正确修复：不要用“当前按键状态”决定模式，要用“整个创建过程的意图”决定

很多实现会在 `pointerup` 时读一次 `altKey` 来判断模式，但用户创建过程中可能既点又拖（或中途松开键），**最终应以“是否发生过拖拽”来判断**。

### 核心策略

- 维护一个 `isPurePolygonalRef`：
  - 只要过程中出现过一次“有效拖拽”（距离 > 阈值），就置为 `false`
- commit 时：
  - `isPurePolygonalRef.current === true` → `polygonal`
  - 否则 → `freehand`

---

## 3) 代码参考（React/TS 伪代码，按你现有结构可直接套）

### 3.1 store 里一定要有并能更新 lassoMode

```ts
// selection.ts (store)
export type LassoMode = 'freehand' | 'polygonal';

type SelectionState = {
  lassoMode: LassoMode;
  setLassoMode: (m: LassoMode) => void;
  // ...
};

export const useSelectionStore = create<SelectionState>((set) => ({
  lassoMode: 'freehand',
  setLassoMode: (m) => set({ lassoMode: m }),
}));
```

### 3.2 handler：追踪“纯多边形意图”

```ts
const DRAG_THRESHOLD = 2; // px

const isPurePolygonalRef = useRef(true);
const lastPtRef = useRef<{ x: number; y: number } | null>(null);

function onPointerDown(e: PointerEvent) {
  isPurePolygonalRef.current = true;
  lastPtRef.current = { x: e.clientX, y: e.clientY };
  // begin path...
}

function onPointerMove(e: PointerEvent) {
  const last = lastPtRef.current;
  if (!last) return;

  const dx = e.clientX - last.x;
  const dy = e.clientY - last.y;
  if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
    isPurePolygonalRef.current = false; // 一旦拖拽过，就不是纯 polygon
  }
  // record point...
}

function onCommitSelection() {
  const setLassoMode = useSelectionStore.getState().setLassoMode;

  const mode = isPurePolygonalRef.current ? 'polygonal' : 'freehand';
  setLassoMode(mode);

  // 接下来生成 mask 时必须用这个 mode
  // pathToMask(points, mode)
}
```

---

## 4) `pathToMask`：对 polygonal 必须完全禁用 RDP/Chaikin

⚠️ 注意：**RDP 也会“削尖角”**（尤其容差 > 1px），所以 polygonal 模式下要“零处理”。

```ts
function pathToMask(points: Point[], lassoMode: LassoMode) {
  let pts = points;

  if (lassoMode === 'freehand') {
    pts = rdpSimplify(pts, 1.5);
    pts = chaikinSmooth(pts, 2);
  } else {
    // polygonal：保持原始顶点，千万别做 rdp/chaikin
    // pts = points;
  }

  // rasterize: moveTo/lineTo/closePath/fill
}
```

---

## 5) 你图里“填充更缩一圈”的补充排查点（如果模式已正确仍存在）

如果你确认 `lassoMode === 'polygonal'` 但仍有“缩边”，再看这两个点：

1. **蚂蚁线和 mask 是否用同一套坐标/同一条 path？**
   常见 bug：蚂蚁线画的是视图坐标（浮点），mask 栅格化时做了 `Math.round/floor`，会造成系统性内缩/偏移。
   建议：mask 栅格化时尽量使用同源 float 坐标，或统一做同样的 transform。

2. **Canvas/WebGL 栅格化的 AA 规则差异**
   如果蚂蚁线是 stroke（虚线）而 mask 是 fill，边缘视觉上就可能不一致。
   解决方式：蚂蚁线也用同一个填充轮廓的“边界采样”渲染，或者至少确保 fillRule、scale、devicePixelRatio 一致。

---

## 我需要你给我两段代码/信息，我可以帮你精准定位到是哪一个点

1. 你当前 `pathToMask` 的实现（尤其是是否无条件走了 RDP/Chaikin、容差是多少）
2. 你在 commit 时如何确定 lassoMode（是读 `altKey`？还是读 store？是否持久化？）

把这两段贴出来，我可以直接按你项目结构给出可合并的 patch。

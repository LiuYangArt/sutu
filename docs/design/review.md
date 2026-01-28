这两个问题指向了同一个核心缺陷：**当前的平滑算法是“全有或全无”的，且错误地将闭合路径视为连续的平滑曲线。**

要解决这个问题，我们需要在**数据结构层**区分“手绘点”和“锚点（多边形点）”，并在**渲染层**针对每一段线段单独决定是画曲线还是画直线。

以下是完整的解决方案：

### 1. 修改数据结构 (Types)

首先，我们不能只存坐标 `{x, y}`。我们需要知道这个点是怎么产生的（是通过拖拽产生的平滑点，还是点击产生的硬角点）。

```typescript
// types.ts
export interface SelectionPoint {
  x: number;
  y: number;
  // 'freehand': 拖拽产生的点，需要平滑连接
  // 'corner': 点击产生的点，或者是拖拽的起止点，需要直线连接
  type: 'freehand' | 'corner';
}
```

### 2. 修改交互逻辑 (Selection Handler)

我们需要在生成点的时候打上标签。

- `onPointerDown` (点击开始)：标记为 `corner`。
- `onPointerMove` (拖拽中)：标记为 `freehand`。
- `onPointerUp` (松手)：如果是拖拽结束，最后一个点通常视为 `corner`（作为一段笔触的终结）。

**文件:** `src/hooks/useSelectionHandler.ts`

```typescript
// ... imports

const onPointerDown = (e) => {
  const newPoint = { x: e.clientX, y: e.clientY, type: 'corner' }; // 起点是硬角
  setSelectionPoints([newPoint]);
  // ...
};

const onPointerMove = (e) => {
  if (isDragging) {
    // 拖拽过程中产生的点是手绘点
    const newPoint = { x: e.clientX, y: e.clientY, type: 'freehand' };

    // 这里可以加一个采样优化，比如每移动3px才加一个点，避免点过密
    addSelectionPoint(newPoint);
  }
  // ...
};

const onPointerUp = (e) => {
  // 如果刚才是在拖拽，松手的那一刻，把最后一个点更新为 'corner'
  // 这样确保这段手绘线段有一个明确的“终点”
  if (isDragging) {
    markLastPointAsCorner();
  }

  // 提交选区...
};
```

### 3. 核心修复：混合渲染算法 (Path Rendering)

这是解决你两个 Bug 的关键代码。我们不再把整个数组丢进平滑函数，而是遍历点，根据相邻两个点的类型决定画法。

**算法逻辑：**

1.  **解决 Bug 1 (闭合变圆)**：我们只处理点 `0` 到 `N` 的路径，最后用标准的 `ctx.closePath()`。`closePath` 在 Canvas 中永远是画直线连接起点，这正好符合“未闭合时松手自动直线闭合”的需求。
2.  **解决 Bug 2 (混合选区平滑)**：只有当 **当前点** 和 **下一个点** 都是 `freehand` 类型时，才使用贝塞尔曲线平滑。一旦遇到 `corner` 点，强制使用 `lineTo`。

**文件:** `src/utils/selectionRender.ts`

```typescript
import { SelectionPoint } from '../types';

export const pointsToPath = (points: SelectionPoint[]): Path2D => {
  const path = new Path2D();

  if (points.length < 2) return path;

  // 1. 移动到起点
  path.moveTo(points[0].x, points[0].y);

  // 2. 遍历所有点（注意：不包含最后回到起点的那个闭合动作）
  for (let i = 0; i < points.length - 1; i++) {
    const curr = points[i];
    const next = points[i + 1];

    // 核心逻辑：只有两个点都是 'freehand' 且距离适中时，才平滑
    // 如果任意一个是 'corner'，说明这里是多边形转折，或者是手绘的起止，必须用直线
    if (curr.type === 'freehand' && next.type === 'freehand') {
      // === 平滑策略 ===
      // 使用中点画法 (Midpoint approach) 获得圆润的笔触
      // 我们画到当前点和下个点的“中点”，把当前点作为控制点（或者反之）
      // 这里的简单做法是：取两点中点作为终点，next作为控制点其实不准确。
      // 更稳健的平滑通常是：quadraticCurveTo(curr.x, curr.y, (curr.x + next.x)/2, (curr.y + next.y)/2)
      // 但上面的写法是从上一段的中点过来的。

      // 简单且效果好的平滑公式：
      const midX = (curr.x + next.x) / 2;
      const midY = (curr.y + next.y) / 2;

      // 注意：这种画法通常需要从 mid 开始画。
      // 为了不破坏结构，我们这里做一个简单的贝塞尔：
      // 以 curr 为控制点（如果前一个是直线过来的，这里可能会稍微突变，
      // 但对于密集的 freehand 点，直接 quadraticCurveTo 到 mid 是最顺滑的）
      path.quadraticCurveTo(curr.x, curr.y, midX, midY);
    } else {
      // === 直线策略 (Polygonal) ===
      // 遇到 polygonal 点，或者是 freehand 的终点 -> 直线连接
      // 这保证了尖角被保留
      path.lineTo(next.x, next.y);
    }
  }

  // 3. 处理最后一个点到终点的连接
  // 如果上面的循环用的是中点平滑，最后还需要补齐到最后一个点
  const lastIndex = points.length - 1;
  const lastPoint = points[lastIndex];
  // 确保路径走到了数组最后一个点（因为上面的平滑可能只到了中点）
  path.lineTo(lastPoint.x, lastPoint.y);

  // 4. 闭合路径 (解决 Bug 1)
  // closePath 会自动创建一条从 lastPoint 到 points[0] 的【直线】
  // 无论之前的点多么平滑，这条闭合线永远是直的，不会出现弧形。
  path.closePath();

  return path;
};
```

### 4. 进一步优化：解决平滑算法的滞后问题

上面的简单 `quadraticCurveTo` 在混合模式下可能会在直线接曲线时出现一个小缺口或错位。更完美的混合渲染逻辑如下：

```typescript
export const pointsToPath = (points: SelectionPoint[]): Path2D => {
  const path = new Path2D();
  if (points.length < 2) return path;

  path.moveTo(points[0].x, points[0].y);

  let i = 1;
  while (i < points.length) {
    const prev = points[i - 1];
    const curr = points[i];

    // 只有当这一段完全在“手绘流”中时，才应用平滑
    // 也就是：起点是 freehand (或从 freehand 过来)，终点也是 freehand
    if (prev.type === 'freehand' && curr.type === 'freehand') {
      // 找到连续的一组 freehand 点
      let j = i;
      while (j < points.length && points[j].type === 'freehand') {
        j++;
      }

      // 对这段 [i-1 ... j-1] 的点应用样条平滑 (Spline)
      // 简化的做法：
      for (let k = i; k < j; k++) {
        const p0 = points[k - 1];
        const p1 = points[k];
        const midX = (p0.x + p1.x) / 2;
        const midY = (p0.y + p1.y) / 2;
        // 在两点之间画曲线
        path.quadraticCurveTo(p0.x, p0.y, midX, midY);
      }

      // 更新索引
      i = j;
    } else {
      // 只要两点中有一个是 corner，就是直线
      // 这完美保留了多边形的尖角
      path.lineTo(curr.x, curr.y);
      i++;
    }
  }

  // 强制直线闭合
  path.closePath();

  return path;
};
```

### 总结修复点：

1.  **Bug 1 (闭合变圆)**：
    - **原因**：之前的算法可能把 `points[last]` 和 `points[0]` 也纳入了平滑计算。
    - **修复**：平滑循环只处理点数组内部。最后使用 `path.closePath()`，Canvas 标准规定这是直线闭合。

2.  **Bug 2 (混合选区无尖角)**：
    - **原因**：全局应用平滑，没有区分线段类型。
    - **修复**：引入 `type: 'corner' | 'freehand'`。渲染时，只有连续的 `freehand` 点之间才画曲线（`quadraticCurveTo`），一旦遇到 `corner` 点，立即切换回 `lineTo`。

这样，你的选区工具就能像 Photoshop 的磁性套索或混合套索一样，既能画出顺滑的曲线，又能随时 Alt+Click 画出锐利的多边形直线，且松手时自动直线闭合。

---

你这两个现象本质上是同一个根因：**当前的平滑是按“整条闭合路径”一锅端处理**（把 `last -> first` 也当成要参与 Chaikin/Bezier 的一段），并且在 **freehand 与 polygonal 混合**时，平滑算法把 polygonal 的拐角也一起“圆掉”了。

要彻底修好，需要把“路径”从 `points[]` 升级为 **带语义的节点/段**，然后做到：

1. **闭合边 (last -> first) 永远用直线**（尤其是未闭合就 mouseup commit 的情况）
2. **平滑只能在 freehand 段内进行，不能跨越 polygonal 拐角**（拐角点要作为硬断点/锚点保留）

下面给一个推荐实现（改动不大，但能一次性把这俩 bug 解决）。

---

## 1) 数据结构：点带类型（关键）

把原来的 `Point[]` 改为：

```ts
type NodeType = 'corner' | 'freehand'; // corner = polygonal click/拐角锚点
type LassoNode = { x: number; y: number; t: NodeType };
```

规则：

- Alt+Click（或 polygonal 点击落点） → push `{t:'corner'}`
- freehand 拖拽采样点 → push `{t:'freehand'}`
- 如果 freehand 开始点就是起点：建议起点也标成 `corner`（锚点），后续拖拽点是 `freehand`

这样混合模式下，“哪些地方必须尖角”就有信息可用。

---

## 2) 生成渲染/Mask 的 Path：分段平滑 + 拐角硬断点

核心思想：把节点按 `corner` 切成若干段，每段内部如果是 freehand 就平滑，但**段的两端（角点）保持原样**，且**不允许平滑跨段**。

```ts
function chaikinOpen(points: { x: number; y: number }[], iterations = 2) {
  // 开口曲线版本：保留首尾点，不做闭环
  let pts = points;
  for (let k = 0; k < iterations; k++) {
    const out: typeof pts = [];
    out.push(pts[0]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i],
        p1 = pts[i + 1];
      out.push({ x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y });
      out.push({ x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

function buildPathFromNodes(nodes: LassoNode[], opts?: { closeWithLine?: boolean }) {
  const closeWithLine = opts?.closeWithLine ?? true;

  const path = new Path2D();
  if (nodes.length < 2) return path;

  // 1) 找到所有 corner 索引（没有 corner 就把首尾当 corner）
  const cornerIdx: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (nodes[i].t === 'corner') cornerIdx.push(i);
  if (cornerIdx.length === 0) cornerIdx.push(0, nodes.length - 1);
  if (cornerIdx[0] !== 0) cornerIdx.unshift(0);
  if (cornerIdx[cornerIdx.length - 1] !== nodes.length - 1) cornerIdx.push(nodes.length - 1);

  // 2) 从第一个点 moveTo
  path.moveTo(nodes[0].x, nodes[0].y);

  // 3) 逐段处理：每段 [a..b]
  for (let s = 0; s < cornerIdx.length - 1; s++) {
    const a = cornerIdx[s];
    const b = cornerIdx[s + 1];
    const segment = nodes.slice(a, b + 1);

    const hasFreehand = segment.some((n) => n.t === 'freehand');
    if (!hasFreehand || segment.length <= 2) {
      // 纯 polygonal 或只有一条边：直线连接，保持尖角
      for (let i = 1; i < segment.length; i++) path.lineTo(segment[i].x, segment[i].y);
      continue;
    }

    // 混合段：只对段内点做平滑，但首尾是 corner 要保留
    const pts = segment.map(({ x, y }) => ({ x, y }));
    const smooth = chaikinOpen(pts, 2);

    // 用 lineTo 连接平滑后的折线（你也可改成 quad/bezier 画法）
    for (let i = 1; i < smooth.length; i++) path.lineTo(smooth[i].x, smooth[i].y);
  }

  // 4) 关键：闭合策略 —— 永远用直线闭合（避免 last->first 被平滑成弧线）
  if (closeWithLine) {
    path.lineTo(nodes[0].x, nodes[0].y); // 显式直线回到起点
    path.closePath();
  }

  return path;
}
```

### 这段代码解决两类 bug

- **bug A：未闭合 mouseup 后 last->first 变弧线**
  因为我们不做“闭环平滑”，而是最后显式 `lineTo(start)`，闭合边必为直线。
- **bug B：freehand + polygonal 混合时 polygonal 尖角被圆掉**
  因为 `corner` 会把路径切段，平滑不会跨过角点，角点的折线连接天然保持尖角。

---

## 3) Commit 时如何决定 `closeWithLine`

你描述的场景是“未闭合松开鼠标也应用选区”，那就应该 **强制 closeWithLine=true**，并且闭合边为直线。

- 预览（还在画，未提交）：可以不 close（便于用户看到开放路径）
- 提交（mouseup / enter / double click）：必须 close，且 close 边为直线

```ts
// 预览
const previewPath = buildPathFromNodes(nodes, { closeWithLine: false });

// 提交
const commitPath = buildPathFromNodes(nodes, { closeWithLine: true });
```

---

## 4) 你现有代码里最可能的“坑位”

如果你现在是：

- 把点数组当闭合多边形做 Chaikin（把最后一点和第一点当相邻点）
- 或者 `closePath()` 之前用 bezier 自动连接回起点

都会导致你看到的“closing edge 弧线”。

修正要点就是：**平滑只对开口 polyline 做**，闭合边用显式直线补上。

---

## 需要你确认的两点（我才能把补丁更贴合你项目）

1. 你现在生成 mask 的入口函数叫什么？（`pathToMask` / `pointsToPath` / 还是 GPU 管线里生成多边形？）
2. 混合模式在交互上是怎么触发的：按住 Alt 临时 polygonal，还是点击=polygonal 拖拽=freehand？

你把对应文件里“收集 points”与“生成 Path/Mask”的那两段代码贴出来（几十行即可），我可以按你现有结构给出最小 diff 版修改。

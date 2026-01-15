w# Visual Lag 测量逻辑修复

**日期**: 2026-01-15
**问题**: Visual Lag 显示 1543.6px，远超预期
**根因**: 测量逻辑错误，测量的是两个连续采样点之间的物理距离，而非真正的视觉滞后

---

## 问题症状

手动验证性能优化时，Debug Panel 显示：

| 指标                 | 值          |
| -------------------- | ----------- |
| **Queue Depth**      | 0 ✅        |
| **Render Latency**   | 10.63ms ✅  |
| **Visual Lag (Max)** | 1543.6px 🚨 |

Queue Depth = 0 说明批量处理有效，但 Visual Lag 数值异常高。

---

## 根因分析

### 错误的测量方式

```typescript
// 之前的代码：测量两个连续处理点之间的距离
const processSinglePoint = (x, y, pressure) => {
  // ...
  if (prevProcessedPosRef.current) {
    lagometerRef.current.measure(prevProcessedPosRef.current, { x, y });
  }
  prevProcessedPosRef.current = { x, y };
};
```

**问题**：当快速移动鼠标时，两个采样点之间的物理距离可能很大（如 1500px），但这只是采样间距，不是视觉滞后。

### Visual Lag 的正确定义

**Visual Lag** = 当前**输入位置**（鼠标/笔尖）和**已渲染到屏幕的位置**之间的距离

```
输入事件 → 队列 → 批量处理 → 渲染
   ↑                           ↑
lastInputPos              lastRenderedPos

Visual Lag = distance(lastInputPos, lastRenderedPos)
```

---

## 修复方案

### 1. 分离追踪变量

```typescript
// 追踪最新输入位置
const lastInputPosRef = useRef<{ x: number; y: number } | null>(null);
// 追踪最后渲染位置
const lastRenderedPosRef = useRef<{ x: number; y: number } | null>(null);
```

### 2. 在事件处理器中更新输入位置

```typescript
// handlePointerMove 中入队时
inputQueueRef.current.push({ x: canvasX, y: canvasY, pressure, pointIndex: idx });
lastInputPosRef.current = { x: canvasX, y: canvasY }; // 记录最新输入
```

### 3. 在处理点时更新渲染位置

```typescript
const processSinglePoint = (x, y, pressure) => {
  processBrushPoint(x, y, pressure, config, pointIndex);
  lastRenderedPosRef.current = { x, y }; // 记录最后渲染位置
};
```

### 4. 在 RAF 循环末尾测量

```typescript
// RAF loop: 渲染后测量
if (needsRenderRef.current) {
  compositeAndRenderWithPreview();
  needsRenderRef.current = false;

  // 测量 Visual Lag：渲染后，当前输入和最后渲染之间的距离
  const inputPos = lastInputPosRef.current;
  const renderedPos = lastRenderedPosRef.current;
  if (inputPos && renderedPos) {
    lagometerRef.current.measure(renderedPos, inputPos);
  }
}
```

---

## 关键洞察

### 测量时机的重要性

- **错误**：在处理每个点时测量（测量的是采样间距）
- **正确**：在渲染后测量（测量的是真正的视觉滞后）

### 生产者-消费者模型中的测量

```
生产者（输入事件）     消费者（RAF 循环）
    ↓                      ↓
 记录 lastInputPos    处理点 → 更新 lastRenderedPos
                           ↓
                      渲染完成后测量
                           ↓
                      Visual Lag = |input - rendered|
```

---

## 教训

1. **理解指标定义**：Visual Lag 是输入和渲染之间的距离，不是连续采样点之间的距离
2. **测量时机很重要**：在正确的时间点测量（渲染后，而非处理时）
3. **分离关注点**：输入追踪和渲染追踪使用独立的变量
4. **阅读异常值**：1543px 的值明显不合理，应该引起警觉

---

## 相关文件

- [Canvas/index.tsx](file:///f:/CodeProjects/PaintBoard/src/components/Canvas/index.tsx) - 核心修改
- [LagometerMonitor.ts](file:///f:/CodeProjects/PaintBoard/src/benchmark/LagometerMonitor.ts) - 测量类
- [performance-optimization-plan.md](file:///f:/CodeProjects/PaintBoard/docs/design/performance-optimization-plan.md) - 优化方案

---

## 迭代修复 (Phase 2)

### 问题

首次修复后 Visual Lag 仍显示 976.9px。

### 额外根因

**跨笔划测量**：`finalizeStroke` 没有重置位置追踪变量，导致：

- 笔划 A 结束时 `lastInputPos = (100, 100)`, `lastRenderedPos = (100, 100)`
- 笔划 B 开始时鼠标在 `(1000, 200)`
- 第一次测量：`distance((100,100), (1000,200)) = 906px` ❌

### 修复

在 `finalizeStroke` 中重置位置追踪：

```typescript
isDrawingRef.current = false;
strokeStateRef.current = 'idle';
// Reset position tracking to avoid cross-stroke lag measurements
lastInputPosRef.current = null;
lastRenderedPosRef.current = null;
```

### 附加简化

1. 移除重复的注释行
2. 简化队列清空逻辑为单行条件表达式：
   ```typescript
   inputQueueRef.current = count === queue.length ? [] : queue.slice(count);
   ```

---

## 迭代修复 (Phase 3)

### 问题

手动绘画时 Visual Lag 始终显示 0。

### 根因

测量时机错误：在渲染后测量，此时队列已清空，`lastInputPos` 和 `lastRenderedPos` 已同步。

```
1. 事件入队 → lastInputPos = 点A
2. RAF 循环处理点A → lastRenderedPos = 点A
3. 渲染完成
4. 测量 distance(A, A) = 0  ❌
```

### 修复

在处理队列**之前**测量：队列尾部（最新输入）和 上一帧渲染位置 之间的距离。

```typescript
const loop = () => {
  const queue = inputQueueRef.current;
  if (queue.length > 0) {
    // Visual Lag: 最新输入 vs 上一帧渲染位置
    const lastQueuedPoint = queue[queue.length - 1]!;
    const renderedPosBefore = lastRenderedPosRef.current;
    if (renderedPosBefore) {
      lagometerRef.current.measure(renderedPosBefore, lastQueuedPoint);
    }

    // 处理点...
  }
};
```

**原理**：如果有积压，队列尾部（最新输入）和渲染位置（上一帧末尾）之间会有距离。

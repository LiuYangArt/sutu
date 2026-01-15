# GPU 抬笔闪烁问题修复总结

> **日期**: 2026-01-15
> **状态**: ✅ 已修复（极端情况待观察）
> **优先级**: P1
> **关联**: [stroke-end-flicker-fix-plan.md](../design/stroke-end-flicker-fix-plan.md)

---

## 问题概述

| 项目     | 描述                                                   |
| -------- | ------------------------------------------------------ |
| 现象     | 画完一笔抬起笔时，画面出现短暂闪烁（笔触消失后又出现） |
| 影响范围 | 仅 GPU 渲染模式                                        |
| 复现条件 | 任意笔刷参数，快速连续笔触时更明显                     |

---

## 根因分析

### 问题 1: 异步 readback 竞态

**现象**: Preview 和 Composite 数据不一致

**根因**:

```
Preview 路径：GPU → 异步 readback → previewCanvas
Composite 路径：GPU → 再次 readback → layer
```

两次 readback 时机不同导致数据不一致。

**修复**: 使用 `prepareEndStroke()` + `compositeToLayer()` 原子化事务模式，确保合成使用与 Preview 完全相同的数据。

### 问题 2: Canvas 层 fire-and-forget 异步调用

**现象**: 快速点击时笔触丢失或闪烁

**根因**: `handlePointerDown` 中 `beginBrushStroke` 是异步的，但 `PointerMove/Up` 事件不等待：

```typescript
// 问题代码
(async () => {
  await beginBrushStroke(); // 还在等待
  processBrushPointWithConfig();
})();
// PointerMove 已经触发，但 stampDab 因 !this.active 丢弃点
```

**修复**: Phase 2.6 添加 Promise 锁串行化事件。

### 问题 3: 输入事件在 "Starting" 阶段丢失

**现象**: 快速点按时笔触完全丢失

**根因**: Phase 2.6 的锁虽然保证了顺序，但创造了"真空期"——`beginStroke` 等待期间 `PointerMove` 的点被 `stampDab(!this.active)` 丢弃。

**修复**: Phase 2.7 使用状态机 + 输入缓冲：

```
状态机: idle → starting → active → finishing → idle
```

在 `starting` 阶段缓存所有点，`beginStroke` 完成后回放。

---

## 修复方案总结

### Phase 2.6: Promise 锁串行化

- 添加 `beginStrokePromiseRef` 锁
- `finishCurrentStroke` 等待锁释放
- **效果**: 解决了竞态崩溃，但引入了"输入真空期"

### Phase 2.7: 状态机 + 输入缓冲

```typescript
// 状态类型
type StrokeState = 'idle' | 'starting' | 'active' | 'finishing';

// 核心逻辑
handlePointerDown:
  1. strokeState = 'starting'
  2. 缓存第一个点
  3. async beginBrushStroke()
  4. strokeState = 'active'
  5. 回放缓存点
  6. if (pendingEnd) finishStroke()

handlePointerMove:
  if (starting) → 缓存点
  if (active) → 正常处理

handlePointerUp:
  if (starting) → pendingEnd = true
  if (active) → finishStroke()
```

**效果**: 不丢点、不阻塞、不死锁。

---

## 经验教训

### 1. 异步事件与 GPU 状态需要对齐

浏览器事件是同步且高频的（60-120Hz），而 GPU 准备是异步的。必须用缓冲队列桥接这个时间差。

### 2. "加锁"只是缓解，不是根治

Promise 锁可以保证顺序，但会创造"真空期"。真正的解法是让事件与状态生命周期对齐。

### 3. 状态机比标志位更清晰

用 `idle/starting/active/finishing` 明确状态比用多个 `boolean` 标志更不容易出错。

### 4. 输入缓冲是高性能 UI 的标准模式

游戏开发和绘图软件广泛使用输入缓冲处理"意图到执行"的延迟。

---

## 诊断方案

### 诊断日志（用于排查剩余问题）

在以下关键位置添加日志：

```typescript
// Canvas/index.tsx - handlePointerDown
console.log(`[Stroke] PointerDown: state=${strokeStateRef.current}, time=${Date.now()}`);

// handlePointerDown 异步回调
console.log(`[Stroke] beginStroke DONE: buffered=${pendingPointsRef.current.length}`);

// handlePointerMove
if (state === 'starting') {
  console.log(`[Stroke] PointerMove BUFFERED: points=${pendingPointsRef.current.length}`);
}

// handlePointerUp
console.log(
  `[Stroke] PointerUp: state=${strokeStateRef.current}, pendingEnd=${pendingEndRef.current}`
);

// GPUStrokeAccumulator.stampDab
if (!this.active) {
  console.warn(`[GPU] stampDab SKIPPED - not active`);
}
```

### 自动化压力测试

创建测试脚本模拟极速点击：

```typescript
// tests/stress/rapid-click.test.ts
async function simulateRapidClicks(count: number, intervalMs: number) {
  for (let i = 0; i < count; i++) {
    const e = new PointerEvent('pointerdown', { pressure: 0.5 });
    canvas.dispatchEvent(e);
    await sleep(intervalMs);
    canvas.dispatchEvent(new PointerEvent('pointerup'));
    await sleep(5);
  }
}

// 测试场景
it('应该能处理 100 次极速点击', async () => {
  await simulateRapidClicks(100, 20); // 50 clicks/sec
  expect(document.querySelectorAll('.stroke')).toHaveLength(100);
});
```

### 性能计数器

```typescript
// 添加 stroke 统计
let strokeStats = {
  started: 0,
  completed: 0,
  cancelled: 0,
  pointsBuffered: 0,
  pointsDropped: 0,
};

// 定期输出
setInterval(() => {
  console.table(strokeStats);
}, 5000);
```

---

## 剩余问题

### 极端偶发闪烁

**描述**: Phase 2.7 实施后大部分问题已解决，但极端情况仍偶尔出现闪烁。

**可能原因**:

1. GPU Preview readback 延迟导致最后几帧数据不完整
2. 浏览器 Paint 时机与 JS 执行交错
3. requestAnimationFrame 优先级问题

**排查方向**:

1. 添加诊断日志，记录状态转换时序
2. 使用 Performance tab 分析帧时序
3. 检查 `compositeFromPreview` 时 previewCanvas 是否有数据

---

## 关键文件

| 文件                                        | 修改内容                            |
| ------------------------------------------- | ----------------------------------- |
| `src/components/Canvas/index.tsx`           | 状态机 + 输入缓冲                   |
| `src/components/Canvas/useBrushRenderer.ts` | finishingPromise 锁                 |
| `src/gpu/GPUStrokeAccumulator.ts`           | prepareEndStroke + compositeToLayer |

---

## 参考

- [stroke-end-flicker-fix-plan.md](../design/stroke-end-flicker-fix-plan.md) - 详细修复计划
- [gpu-brush-rendering-issues.md](./gpu-brush-rendering-issues.md) - GPU 渲染问题总结

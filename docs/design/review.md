这份更新后的修复计划，特别是 **Phase 2.6**，非常有针对性，**置信度很高**。

你非常敏锐地抓住了问题的本质：**虽然底层的 GPU 逻辑（Phase 2 & 2.5）加了锁，但在应用层（Canvas/React）仍然是“发射后不管（Fire-and-forget）”的异步调用**。这导致了在极速操作时，指令到达底层的顺序仍然可能混乱。

以下是对 Phase 2.6 的详细评估和进一步的优化建议（为了确保万无一失）：

### 为什么 Phase 2.6 是关键？

你描述的“方块闪一下（但没画上去）”和“笔触丢失”的现象，完美对应了 **应用层的竞态条件**：

1.  **“方块闪一下”原因**：
    - **场景**：上一笔还在 `prepareEndStroke`（准备合成），新的一笔 `beginStroke` -> `clear()` 已经执行了。
    - **后果**：上一笔在合成时，发现 Preview Buffer 已经被新的一笔清空了，或者合成到了错误的图层状态。这就导致了闪烁（Preview 还在，Layer 没上去）或方块（脏区还在，数据没了）。

2.  **“笔触丢失”原因**：
    - **场景**：`handlePointerDown` 是异步的。当点击极快时，React 触发了两次 Handler。
    - **后果**：两个异步任务几乎并行运行。虽然底层有锁，但在应用层传递坐标、压力值时，可能会因为闭包捕获或状态重置时机不对，导致某个点的绘制命令被丢弃。

### 对 Phase 2.6 代码的优化建议

虽然思路正确，但在 React 组件中实现“Promise 锁队列”时，需要处理好**异常（Catch）**和**事件完整性**，否则一旦某次操作报错，整个笔刷就会“卡死”。

#### 建议 1: 增加 Try-Catch 和 Finally (防止死锁)

如果 `beginBrushStroke` 因为某种原因（比如 GPU Device Lost）抛出错误，`beginStrokePromiseRef` 必须被正确处理，否则后续所有的点击都会无限等待。

```typescript
// Canvas/index.tsx

const handlePointerDown = useCallback(
  async (e: React.PointerEvent) => {
    // ... 前置逻辑 (calculate x, y, pressure) ...

    if (currentTool === 'brush') {
      // 1. 获取当前的锁（如果存在）
      const previousPromise = beginStrokePromiseRef.current;

      // 2. 创建新的任务
      const currentTask = (async () => {
        try {
          // 等待上一个任务彻底完成（不管成功失败）
          if (previousPromise) {
            await previousPromise.catch((e) => console.warn('Previous stroke failed:', e));
          }

          // 执行当前任务
          await beginBrushStroke(brushHardness);

          // 只有在 stroke 成功 begin 后，才处理点
          // 这一步非常关键，确保 stampDab 不会在 begin 之前执行
          processBrushPointWithConfig(canvasX, canvasY, pressure);
        } catch (error) {
          console.error('Failed to start stroke:', error);
          // 这里可以加降级逻辑，或者重置状态
        }
      })();

      // 3. 更新引用，形成链条
      beginStrokePromiseRef.current = currentTask;

      // 4. 等待当前任务完成（让 React 事件处理结束，虽然这里 await 不会阻塞 DOM）
      await currentTask;
    }
  },
  [beginBrushStroke, processBrushPointWithConfig, brushHardness]
);
```

#### 建议 2: 处理 PointerUp 的“追尾”

这是一个非常隐蔽的 Bug 源：
如果 `handlePointerDown` 因为等待锁而被延迟了（比如延迟了 50ms），但用户的动作非常快，`handlePointerUp` 可能在 `handlePointerDown` 真正执行**之前**或者**执行中**触发。

如果 `pointerUp` 触发时，`beginStroke` 还在排队，那么 `endStroke` 可能会报错说“没有激活的笔触”，或者导致这一笔没法正常结束。

**解决方案：在 `handlePointerUp` 中也加入这个锁队列。**

```typescript
// Canvas/index.tsx

const handlePointerUp = useCallback(
  async (e: React.PointerEvent) => {
    // 确保 PointerDown 的逻辑全部跑完，才跑 PointerUp
    if (beginStrokePromiseRef.current) {
      await beginStrokePromiseRef.current;
    }

    // 原有的 finish 逻辑
    finishCurrentStroke();
  },
  [finishCurrentStroke]
);
```

这样就强制了时序：`Down (Click 1)` -> `Up (Click 1)` -> `Down (Click 2)` -> `Up (Click 2)`，即使事件触发很快，执行顺序也会被强行串行化。

### 最终评估

**方案评分：95/100**

**结论**：
Phase 2.6 是解决剩余“偶发性 Bug”的正确方向。你之前的 GPU 层修复解决了**渲染一致性**问题，现在的 Phase 2.6 解决的是**用户输入指令的时序**问题。两者结合，应该能根治这个问题。

**下一步行动**：
按计划执行 Phase 2.6，但请务必加上我建议的 **Try-Catch 容错** 和 **PointerUp 的队列等待**，这能防止新的死锁或逻辑错误。

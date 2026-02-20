# GPU 空提交历史污染导致 Undo warning 复盘（2026-02-20）

**日期**：2026-02-20  
**状态**：已修复

## 背景

在 GPU-first 画笔链路下，偶发出现如下控制台告警：

`[History] Missing CPU beforeImage for undo fallback`

该告警出现在普通笔刷/橡皮收笔后的撤销路径，不是固定复现，容易被误判为输入层（WinTab/MacNative）问题。

## 现象

1. 绘制极短笔划或无可见改动笔划后，按 `Ctrl+Z`。  
2. 偶发看到 `Missing CPU beforeImage for undo fallback`。  
3. 伴随条目通常是 `snapshotMode: 'gpu'`，且该条目没有 `beforeImage`。

## 根因

根因是“空 GPU 提交也会落 history”：

1. 起笔默认走 GPU history capture，不强制带 CPU `beforeImage` 备份。  
2. 收笔阶段调用 `commitStrokeGpu()` 后，没有消费 `committed` 结果。  
3. 即使 `dirtyTiles.length === 0`（即 `committed: false`），仍会执行 `saveStrokeToHistory()`。  
4. 这类条目进入 undo 时，GPU history `apply()` 返回 `false`，回落 CPU fallback。  
5. 由于本条目没有 CPU `beforeImage`，触发 warning。

本质上是历史语义不一致：**“无实际提交”被错误地当作“可撤销历史项”**。

## 修复

在收笔逻辑补齐“提交结果门控”：

1. `useStrokeProcessor` 在 GPU 路径读取 `commitStrokeGpu()` 返回的 `committed`。  
2. 仅当 `committed === true` 时执行 `saveStrokeToHistory()`。  
3. 当 `committed === false` 时执行 `discardCapturedStrokeHistory()`，主动清理这次起笔快照。  
4. `Canvas/index.tsx` 将 `discardCapturedStrokeHistory` 透传给 `useStrokeProcessor`。

## 自动化补强

新增 wiring 回归测试：

- `src/components/Canvas/__tests__/useStrokeProcessor.historyWiring.test.ts`

覆盖点：GPU commit 结果被消费；空提交路径必须调用 `discardCapturedStrokeHistory()`，不能继续写 history。

## 验证

1. `pnpm -s vitest run src/components/Canvas/__tests__/useStrokeProcessor.historyWiring.test.ts` 通过。  
2. `pnpm -s typecheck` 通过。  
3. 手测建议：快速点按/极短笔划后连续 `Ctrl+Z`，确认不再出现该 warning。

## 经验沉淀

1. 任何“commit”型 API 都必须显式消费结果，不能只调用不判断。  
2. 历史系统应遵循硬约束：**无可见写入（no-op）不入历史**。  
3. GPU-only 快照路径若允许无 CPU 备份，必须保证失败回退前就过滤掉无效历史项。  
4. 对“偶发 warning”要优先检查状态机和语义一致性，而不是先怀疑输入设备层。

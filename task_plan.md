# Task Plan: GPU-First M2（单层可绘）

## Goal
按 `docs/plans/2026-02-05-gpu-first-brush-design.md` 完成 M2 单层 GPU 可绘闭环，并保留多层 Canvas2D fallback。

## Phases（补全计划执行）
- [x] Phase 1：接口契约收口
- [x] Phase 2：引入 `GpuStrokeCommitCoordinator`
- [x] Phase 3：LRU 预算接线（probe -> localStorage -> renderer）
- [x] Phase 4：SelectionMask 改为 `r8unorm`
- [x] Phase 5：验收模板回填到设计文档

## 已完成实现
- 新增类型契约：`GpuScratchHandle` / `GpuStrokePrepareResult` / `GpuStrokeCommitResult`
- `useBrushRenderer` 收口为：
  - `getScratchHandle()`
  - `prepareStrokeEndGpu()`
  - `clearScratchGpu()`
- 旧接口兼容别名仍保留一周期：
  - `getGpuScratchTexture()`
  - `prepareEndStrokeGpu()`
  - `clearGpuScratch()`
  - `getGpuDirtyRect()`
  - `getGpuRenderScale()`
- 新增 `GpuStrokeCommitCoordinator`，`Canvas/index.tsx` 不再直接拼 commit/readback 流程。
- 新增 `ResidencyBudget`：
  - `__gpuM0Baseline()` 后缓存预算（ratio=0.6）
  - `GpuCanvasRenderer` 初始化读取缓存并设置 budget
- Selection mask 已从 `rgba8unorm` 切到 `r8unorm`，shader 读取 `mask.r`。
- 设计文档新增“M2 验收记录模板”。

## 已确认决策
- Layer 格式：`rgba8unorm (linear + dither)`（M0 阶段先锁定）
- Tile size：M2 先用 `512`
- GPU 显示条件：`renderMode=gpu && currentTool=brush && visibleLayerCount<=1`
- readback 策略：仅 stroke end（dirty）与导出时执行

## 下一步（验收执行）
1. 跑一次 `window.__gpuM0Baseline()`，确认预算缓存写入。
2. 按设计文档 13.2 的 4 个手动场景执行并记录结果。
3. 在设计文档 13.3 模板中填写 PASS/FAIL 与阻塞项。

## Status
**In Progress** - 代码补全已完成，待执行人工验收并回填结果

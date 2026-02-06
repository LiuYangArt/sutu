# Task Plan: GPU-First M2（单层可绘）

## Goal
按 `docs/plans/2026-02-05-gpu-first-brush-design.md` 完成 M2 单层 GPU 可绘闭环，并保留多层 Canvas2D fallback。  
当前阶段优先级调整为：**稳定性正确性 > 性能优化**。

## Phases（补全计划执行）
- [x] Phase 1：接口契约收口
- [x] Phase 2：引入 `GpuStrokeCommitCoordinator`
- [x] Phase 3：LRU 预算接线（probe -> localStorage -> renderer）
- [x] Phase 4：SelectionMask 改为 `r8unorm`
- [x] Phase 5：验收模板回填到设计文档
- [ ] Phase 6A：稳定性回归门禁（压感/丢笔触/消失）
- [ ] Phase 6B：5000x5000 性能收敛（在 6A 通过后执行）

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
- 已执行一次压感实验改动回退（见 `docs/postmortem/2026-02-06-gpu-m2-pressure-regression-rollback.md`）：
  - 回退 `inputUtils/usePointerHandlers/useStrokeProcessor` 的本轮输入策略改动
  - 保留 `useBrushRenderer` 的 GPU commit finishing lock（已验证有效）

## 已确认决策
- Layer 格式：`rgba8unorm (linear + dither)`（M0 阶段先锁定）
- Tile size：M2 先用 `512`
- GPU 显示条件：`renderMode=gpu && currentTool=brush && visibleLayerCount<=1`
- readback 策略：仅 stroke end（dirty）与导出时执行

## 下一步（先稳定，再性能）
1. [ ] 稳定性 Gate（必须先过）
   - 5000x5000 单层连续 100 笔：无丢笔触、无“预览出现后消失”
   - 压感起笔/行笔连续：无异常 1px 细线伪迹
   - 无 `GPUValidationError` / device lost
   - 抬笔后无延迟补 dab
2. [x] 停掉渲染帧内的重复整层上传
   - `syncLayerFromCanvas` 已恢复 revision guard。
   - `commitStrokeGpu` 成功后不再强制 `markLayerDirty` 触发整层回传。
3. [x] 上传策略补齐“按 tile 上传”能力
   - 新增 `uploadTilesFromCanvas(..., { onlyMissing })`。
   - `commitStroke` 支持 `baseLayerCanvas`，缺失 tile 时只补齐该 tile 的底图像素。
4. [ ] 继续压缩 GPU path 的 CPU 参与（仅在稳定性 Gate 通过后）
   - 排查并移除非必要 `readback -> CPU layer -> 再回传` 的链路依赖。
   - 已修复：pointer-up 后延迟尾 dab（队列消费时序 + 收尾立即 flush/render）。
   - 已修复：GPU commit 路径补 finishing lock，避免新笔触提前清 scratch 导致偶发丢笔。
   - 待确认：长时间回归是否仍出现“预览出现但提交丢失”。
5. [ ] 补充性能验收
   - 5000x5000 连续绘制 30s，记录平均帧时间、commit 耗时、dirtyTiles 数量。
   - 对比改造前后数据并回填设计文档。
6. [ ] 多层可见性能说明与下一阶段
   - 当前 M2 仍是单层 GPU 显示（`visibleLayerCount <= 1`）。
   - 新建可见图层后会走 Canvas2D fallback，性能回落属于当前边界。

## Status
**In Progress** - M2 功能链路已打通，当前处于 Phase 6A（稳定性回归门禁）

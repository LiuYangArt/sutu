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
- 新增 M2 稳定性解阻改动（2026-02-06）：
  - 启动期 Dual 预热条件化跳过（`width*height >= 16_000_000` 或 `maxBufferSize <= 536_870_912`）
  - `GPUStrokeAccumulator.resetDiagnostics()` + 诊断分代字段（`diagnosticsSessionId` / `resetAtMs`）
  - 全局接口 `window.__gpuBrushDiagnosticsReset()`（Debug Panel 按钮接线）

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

## 最新检查点（2026-02-06，Phase 6A 实施后）
- [x] `case-5000-04.json` 已可稳定回放并在画布正确出图（`__strokeCaptureReplay` 可用）。
- [x] 回放 1px 细线问题已修复（回放事件不再被 WinTab 实时流错误覆盖）。
- [x] 录制压感路径已修复关键大小写问题（`backend: wintab` 识别）。
- [x] 启动期 Dual 预热报错解阻实现已落地（条件化跳过 + 诊断事件记录）。
- [x] 诊断分代/重置能力已落地（含 Debug Panel 按钮）。
- [x] 自动检查通过：`pnpm -s typecheck`、`pnpm -s test -- useGlobalExports`、`pnpm -s test -- startupPrewarmPolicy`、`pnpm -s test -- DebugPanel`。
- [ ] 稳定性 Gate 待最终手工复验（3 轮 replay + 20 笔压感短测）。

### 本轮关键结论
- 当前“能画、能回放”已恢复，主链路可继续推进。
- 诊断里的报错集中在启动/预热相关 submit（`GPU Startup Init Encoder` / `Prewarm Dual Readback Encoder` / `Dual Blend Encoder`），不是本次回放时即时新增的绘制报错，但会污染门禁判断，必须清理。
- M2 单层目标下，Dual 预热路径不是必需项，可降级为按需启用或直接禁用预热。

### 接下来按顺序做（不并行）
1. [x] 清理启动期 Dual 预热大缓冲报错
   - `initializePresentableTextures` 已加入 Dual 启动预热跳过策略。
   - 跳过时写入 `startup-dual-prewarm-skipped` 诊断事件（含画布尺寸/设备上限/原因）。
2. [x] 诊断数据分代/清理
   - `uncapturedErrors` / `events` / `submitHistory` 可通过 reset 进入新会话统计。
   - `window.__gpuBrushDiagnosticsReset()` 已可直接触发（Debug Panel）。
3. [ ] 回归验收（自动回放 + 手工抽检）
   - 用 `case-5000-04.json` 连续回放 3 轮，确认无新增 validation error。
   - 手工压感短测（20 笔）确认起笔/行笔无 1px 伪迹。

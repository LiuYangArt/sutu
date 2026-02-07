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
- [ ] Phase 6A：稳定性回归门禁（压感/丢笔触/消失，封版前窗口复验；今日不再追加复测）
- [ ] Phase 6B：5000x5000 性能收敛（门禁能力已落地；策略切换为“冻结基线 + 无 readback 对比优先”）
- [x] Phase 6C：单层 GPU 双轨历史（GPU 脏 tile 快照 + CPU 历史兜底）

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
- 新增 Phase 6A 门禁整合改动（2026-02-06）：
  - `Run Phase6A Auto Gate` 支持每轮 replay 前清层并等待 1 帧，结果写入 `clearPerRound`
  - `Record 20-Stroke Manual Gate` 改为 checklist + 诊断联合判定（不再仅 confirm）
  - 诊断统计新增 `startPressureFallbackCount`
- 压感策略实验（已回退，见 postmortem）：
  - 大画布起笔保护与 `currentPoint` 新鲜度策略曾上线，但造成手绘压感回归
  - 已回退至基线输入路径，用户实测“压感已恢复”
  - 保留 Debug Panel 门禁与诊断框架，作为后续稳定性验证工具
- 新增 Phase 6B-3 对比工具落地（2026-02-06）：
  - commit 指标快照新增 `readbackMode` / `readbackBypassedCount`。
  - `GpuStrokeCommitCoordinator` 新增 `setReadbackMode/getReadbackMode`，支持调试态禁用 readback。
  - 新增全局接口：`window.__gpuBrushCommitReadbackMode()` / `window.__gpuBrushCommitReadbackModeSet(mode)`。
  - Debug Panel 新增 `Run Phase6B-3 Readback A/B Compare`（固定 `case-5000-04`、`A->B->B->A`、每种模式 replay-only 30s、清层耗时单列、输出对比报告）。
- 新增 Debug-only 无 readback 试点开关（2026-02-06）：
  - 新增全局接口：`window.__gpuBrushNoReadbackPilot()` / `window.__gpuBrushNoReadbackPilotSet(enabled)`。
  - Debug Panel 新增 `No-Readback Pilot` 按钮（开启后 commit readback 关闭；默认行为不变）。
  - Debug Panel 新增 `Run No-Readback Pilot Gate (30s)`（固定 `case-5000-04`，自动启停 pilot，输出验收报告）。
  - 试点模式下优先拦截 `Undo/Redo`（避免 CPU layer 强一致依赖导致的误判）。
- 新增交互稳定性修复（2026-02-06）：
  - 修复 `undo` 偶发一次撤销多笔（笔触收尾与历史入栈时序一致化）。
  - 修复首次 `undo` 突发延迟（增加空闲期预同步，降低首个撤销抖动）。
  - 修复 `brush/zoom/eyedropper` 快速切换时上一笔闪烁。
  - 修复未抬笔切 `zoom` 并立即缩放时偶发丢笔。
  - 吸色切换性能优化：优先 GPU 单像素采样，降低 CPU 同步路径触发概率。
- 新增单层 GPU 双轨历史落地（2026-02-06）：
  - `StrokeEntry` 扩展为 `entryId + snapshotMode(cpu|gpu)`，`pushStroke` 改为对象签名。
  - 新增 `GpuStrokeHistoryStore`（脏 tile before/after 快照、budget、prune、stats）。
  - `commitStroke`/`GpuStrokeCommitCoordinator.commit` 已支持 historyCapture 透传并自动 `finalizeStroke`。
  - `useLayerOperations` 已接入双轨分支：GPU 路径优先 apply 快照，失败再走 CPU 兜底。
  - CPU 笔刷路径保持不变（新逻辑受 GPU 单层条件保护）。
- 新增本轮代码收敛（2026-02-06，code simplifier）：
  - `Canvas/index.tsx` 抽取单层 GPU 条件、历史预算计算、readback mode 设置与 tile key 解析公共逻辑。
  - `useLayerOperations.ts` 收敛 `captureBeforeImage/saveStrokeToHistory` 的双轨分支重复代码。
  - `GpuStrokeHistoryStore.ts` 抽取 active stroke/tile pair 公共私有方法，减少 before/after 捕获重复。
  - `GpuStrokeCommitCoordinator.ts` 收敛 early-exit result 生成逻辑。
  - 以上均为可维护性优化，不改变既有行为与外部接口语义。

## 已确认决策
- Layer 格式：`rgba8unorm (linear + dither)`（M0 阶段先锁定）
- Tile size：M2 先用 `512`
- GPU 显示条件：`brushBackend=gpu && gpuAvailable && tool∈{brush,zoom,eyedropper} && visible>=1 && visible blend∈{normal,multiply,screen,overlay}`
- GPU 历史条件（M3 收口后）：`gpuDisplayActive && currentTool==='brush'`
- readback 策略：仅 stroke end（dirty）与导出时执行

## 下一步（先稳定，再性能）
1. [ ] 稳定性 Gate（封版前执行；今日暂停新增复测）
   - 当日决议：不再追加 3 轮 replay 与 20 笔手工复测，维持现有证据集。
   - 状态口径：继续保持 `PARTIAL PASS`，不宣告 6A 通过。
2. [x] 停掉渲染帧内的重复整层上传
   - `syncLayerFromCanvas` 已恢复 revision guard。
   - `commitStrokeGpu` 成功后不再强制 `markLayerDirty` 触发整层回传。
3. [x] 上传策略补齐“按 tile 上传”能力
   - 新增 `uploadTilesFromCanvas(..., { onlyMissing })`。
   - `commitStroke` 支持 `baseLayerCanvas`，缺失 tile 时只补齐该 tile 的底图像素。
4. [ ] 继续压缩 GPU path 的 CPU 参与（临时豁免下可先探索）
   - 排查并移除非必要 `readback -> CPU layer -> 再回传` 的链路依赖。
   - [x] 已完成单层双轨历史一期：起笔前不再强制 CPU `beforeImage` 同步（预算允许时走 GPU 快照）。
   - [x] 已新增 Debug-only `No-Readback Pilot` 试点开关（默认路径不变）。
   - [x] 在目标硬件完成首轮试点验收（`2026-02-06T13:59:59.399Z`，`No-Readback Pilot Gate: PASS`）。
   - [x] 已完成两轮试点复验并回填文档（`2026-02-06T14:06:20.517Z` / `2026-02-06T14:07:56.249Z`，均 PASS）。
   - 已修复：pointer-up 后延迟尾 dab（队列消费时序 + 收尾立即 flush/render）。
   - 已修复：GPU commit 路径补 finishing lock，避免新笔触提前清 scratch 导致偶发丢笔。
   - [x] 已修复：未抬笔切 `zoom` 并立即缩放导致偶发丢笔（工具切换先收笔 + 收尾不再绑定工具态）。
5. [x] Phase 6B-1：性能门禁能力落地（DebugPanel）
   - 已新增 `Run Phase6B Perf Gate (30s)`，复用 replay 流程，自动输出 Frame/Commit/Diagnostics 三类报告。
   - 已新增全局接口：`window.__gpuBrushCommitMetrics()` / `window.__gpuBrushCommitMetricsReset()`。
   - 已新增 commit 指标聚合：`attemptCount/committedCount/avg*/max*/dirtyTiles`。
6. [x] Phase 6B-2：5000x5000 基线冻结与回填
   - 以 `case-5000-04` 冻结当前过渡态基线（A 组基线来自 6B-3 实测，含 `avg readbackMs`、frame p95/p99、dirtyTiles、稳定性信号）。
   - 回填到设计文档并标注“非封版预结论”。
7. [x] Phase 6B-3：无 readback 路线对比验证（优先）
   - [x] 对比执行器已落地：固定 `case-5000-04`，执行 `A->B->B->A`，按 replay-only 30s 采样并输出差异报告（无硬阈值）。
   - [x] 在目标硬件执行两轮实测并回填设计文档 13.10（`2026-02-06`，两轮均 PASS，A/B 聚合 + Delta + 稳定性信号）。
8. [ ] 多层可见性能说明与下一阶段
   - 当前 M2 仍是单层 GPU 显示（`visibleLayerCount <= 1`）。
   - 新建可见图层后会走 Canvas2D fallback，性能回落属于当前边界。

## Status
**In Progress** - M2 功能链路已打通；交互稳定性问题（undo/切工具闪烁/吸色卡顿/切 zoom 丢笔）已修复；按 2026-02-06 当日决议停止追加复测，维持 Phase 6A `PARTIAL PASS`；Phase 6B-2/6B-3 已完成，当前进入 6B 后续落地与多层阶段说明整理

## M3 最小闭环进展（2026-02-07）
- 已落地多图层 GPU 显示合成主链路（`normal/multiply/screen/overlay`），不再由 `visibleLayerCount > 1` 直接触发回退。
- 已落地 `below` tile cache（正确性优先策略）：
  - active layer 变化、below 层顺序/opacity/blend/revision 或 GPU 内容代次变化时自动失效重建。
  - `above` 仍按层实时叠加，未做独立像素缓存。
- 已将图层脏标记从全局改为按 layer 维度（`markLayerDirty(layerId | layerIds)`），并引入 per-layer revision 同步策略。
- 已新增调试指标：
  - `window.__gpuLayerStackCacheStats()`；
  - Debug Panel 增加 below cache hit/miss/tiles/invalidation 展示。
- 已新增自动化测试：
  - `gpuLayerStackPolicy.test.ts`（门禁与 revision 逻辑）；
  - `layerStackCache.test.ts`（below cache 签名/失效条件）。
- 已完成 M3 多层 GPU 历史收口（2026-02-07）：
  - 新增 `isGpuHistoryPathAvailable`，`gpuHistoryEnabled` 从“单层限制”改为“跟随 GPU 显示 + brush 工具”。
  - `commitStrokeGpu` 提交历史 entry 改为直接读取 `pendingGpuHistoryEntryIdRef`，不再受瞬时 gate 抖动影响。
  - `applyGpuStrokeHistory` 取消对当前 `gpuHistoryEnabled` 的硬短路；仅要求 `historyStore + gpuRenderer` 可用即可应用 GPU 快照（失败仍回退 CPU 历史）。
  - 自动检查：`pnpm -s typecheck`、`pnpm -s test -- gpuLayerStackPolicy GpuStrokeHistoryStore GpuStrokeCommitCoordinator` 均 PASS。
- 已完成首轮线上问题修复（2026-02-07）：
  - 修复 `renderLayerStackFrame` pass 嵌套导致的 `GPUValidationError`（画布不显示）。
  - 修复非 normal blend 在可见性切换后的整屏发黑（blend 公式 + uniform 覆盖问题）。
  - 修复吸色语义为“所见即所得”，透明像素不再吸黑。
  - 修复 ColorPanel 在吸色后 HSVA 光标不同步。
- 调试经验已沉淀：
  - `docs/postmortem/2026-02-07-m3-layer-stack-black-canvas-eyedropper-palette-sync.md`
- 已执行本轮 `code-simplifier` 收敛（仅可维护性优化，不改行为）：
  - `GpuCanvasRenderer.ts`：layerBlend uniform 游标逻辑改为直接返回 offset，减少中间状态与误用风险。
  - `Canvas/index.tsx`：移除 `sampleGpuPixelColor` 冗余依赖。
  - `ColorPanel/index.tsx`：颜色同步判定分支简化，提升可读性。
- 已完成：M3 手工门禁回放与 4K/多层稳定性验收回填（2026-02-07，用户本机 UI 环境 A/B/C/D 场景均 PASS）。

## 今日决议（2026-02-06）
- 不再执行新增稳定性回归测试（含 3 轮 replay 与 20 笔手工短测）。
- 现有结论保持不变：6A 维持 `PARTIAL PASS`，所有性能结论继续标注“非封版预结论”。
- 封版前仍需回到 6A 全量门禁复验。
- 本轮代码收敛按该决议执行：不追加重复回归测试，仅更新实现与文档状态。

## Phase 6A 临时豁免决议（2026-02-06）
- 选择路线：临时豁免（先推进后续项，压感细头问题后置处理）。
- 当前判断：
  - Auto Gate：PASS（`uncapturedErrors=0`、`deviceLost=NO`、`startPressureFallbackCount=0`）。
  - Manual checklist：第一条“无起笔细头”暂不满足。
- 执行规则：
  - 允许进入后续任务（含 Phase 6B 探索）。
  - `Phase 6A` 不勾选通过，所有性能结论标注“非封版”。
  - 最终封版前必须回到 6A 完整门禁并复验通过。

## 最新检查点（2026-02-06，Phase 6A 实施后）
- [x] `case-5000-04.json` 已可稳定回放并在画布正确出图（`__strokeCaptureReplay` 可用）。
- [x] 回放 1px 细线问题已修复（回放事件不再被 WinTab 实时流错误覆盖）。
- [x] 录制压感路径已修复关键大小写问题（`backend: wintab` 识别）。
- [x] 启动期 Dual 预热报错解阻实现已落地（条件化跳过 + 诊断事件记录）。
- [x] 诊断分代/重置能力已落地（含 Debug Panel 按钮）。
- [x] 自动检查通过：`pnpm -s typecheck`、`pnpm -s test -- useGlobalExports`、`pnpm -s test -- startupPrewarmPolicy`、`pnpm -s test -- DebugPanel`。
- [x] 新增检查通过：`pnpm -s test -- inputUtils`（已回到基线输入行为断言）。
- [x] 新增 Phase 6B 门禁能力：`Run Phase6B Perf Gate (30s)`（含 Frame/Commit/Diagnostics 报告）。
- [x] 新增 commit 指标接口：`__gpuBrushCommitMetrics` / `__gpuBrushCommitMetricsReset`。
- [x] 新增自动检查通过：`pnpm -s test -- GpuStrokeCommitCoordinator`。
- [x] 新增 Phase 6B-3 对比能力：`Run Phase6B-3 Readback A/B Compare`（固定 case、`A->B->B->A`、回放时段统计）。
- [x] 新增 readback mode 调试接口：`__gpuBrushCommitReadbackMode` / `__gpuBrushCommitReadbackModeSet`。
- [x] 新增自动检查通过：`pnpm -s typecheck`、`pnpm -s test -- GpuStrokeCommitCoordinator`、`pnpm -s test -- useGlobalExports`、`pnpm -s test -- DebugPanel`。
- [x] 新增 6B-3 实测回填（`2026-02-06`，`13:16`/`13:21` 两轮）：
  - 两轮均 `Phase6B-3 Compare: PASS`，且 `uncapturedErrors=0`、`deviceLost=NO`、`mode restored=YES`。
  - Delta（B-A）跨轮均值：`commit avg readback -58.63ms`、`commit avg total -58.51ms`、`frame p95 -2.80ms`、`frame p99 -26.60ms`、`dirtyTiles -0.72`。
- [x] 6B-2 基线冻结与文档回填已完成（2026-02-06）：
  - 过渡态 A 组基线与 No-Readback Pilot 三轮结果已写入设计文档（13.10.1 / 13.12）。
  - 统一标注为“非封版预结论”，与 6A 临时豁免口径一致。
- [x] 新增 No-Readback Pilot Gate 首轮验收（`2026-02-06T13:59:59.399Z`）：
  - `No-Readback Pilot Gate: PASS`，且 `uncapturedErrors=0`、`deviceLost=NO`、`pilot restored=YES`。
  - commit：`avg readback/total = 0.00 / 2.61ms`，`readbackBypassedCount=56`，`mode=disabled`。
  - 对基线 A（`62.27ms`）的 `avg total` 差值：`-59.66ms`（非封版预结论）。
- [x] 新增 No-Readback Pilot Gate 两轮复验（`2026-02-06T14:06:20.517Z` / `2026-02-06T14:07:56.249Z`）：
  - 两轮均 `No-Readback Pilot Gate: PASS`，且 `uncapturedErrors=0`、`deviceLost=NO`、`pilot restored=YES`。
  - commit：`avg readback/total = 0.00 / 2.42ms`、`0.00 / 3.69ms`，`readbackBypassedCount=56`（每轮）。
  - 三轮均值（含首轮）：`commit avg total 2.91ms`、`delta vs baseline A(62.27ms) = -59.36ms`。
- [x] 压感策略实验回退后，用户手测确认压感恢复可用（2026-02-06）。
- [x] Auto Gate 最新实测：PASS（`case-5000-04.json`，session=3，`startPressureFallbackCount=0`）。
- [x] 用户回归确认：`undo/zoom/eyedropper` 当前可用，切换不再闪烁与明显卡顿（2026-02-06）。
- [x] 已修复竞态：未抬笔切 `zoom` 并立即缩放导致偶发丢笔（工具切换统一先收笔 + 收尾按 stroke 状态执行）。
- [x] 自动验证通过：`pnpm -s typecheck` + `pnpm -s test`（`31 passed / 204 passed`）。
- [ ] 稳定性 Gate 待封版前手工复验（3 轮 replay + 20 笔压感短测；今日暂停新增复测）。

### 本轮关键结论
- 当前“能画、能回放”已恢复，主链路可继续推进。
- 诊断里的报错集中在启动/预热相关 submit（`GPU Startup Init Encoder` / `Prewarm Dual Readback Encoder` / `Dual Blend Encoder`），不是本次回放时即时新增的绘制报错，但会污染门禁判断，必须清理。
- M2 单层目标下，Dual 预热路径不是必需项，可降级为按需启用或直接禁用预热。

### 决策更新（2026-02-06，Phase 6B 路线切换）
- 背景：设计终态目标是“实时无 readback”，当前实现仍是过渡态（stroke-end dirty readback）。
- 结论：
  - `57ms -> 40ms` 的 readback 微优化不再作为主目标；
  - 先冻结当前基线（作为对照组），再优先推进“无 readback 原型”并做同口径门禁对比。
- 执行规则：
  - 允许做必要的安全性/稳定性修补，但避免深挖 readback 微优化；
  - 6B 阶段评估重心调整为“当前 vs 无 readback”的差异。

### 接下来按顺序做（不并行）
1. [x] 清理启动期 Dual 预热大缓冲报错
   - `initializePresentableTextures` 已加入 Dual 启动预热跳过策略。
   - 跳过时写入 `startup-dual-prewarm-skipped` 诊断事件（含画布尺寸/设备上限/原因）。
2. [x] 诊断数据分代/清理
   - `uncapturedErrors` / `events` / `submitHistory` 可通过 reset 进入新会话统计。
   - `window.__gpuBrushDiagnosticsReset()` 已可直接触发（Debug Panel）。
3. [x] Phase 6B-2：基线冻结与回填
   - A 组基线、B 组对比与 Pilot 三轮结果已沉淀到设计文档。
4. [x] Phase 6B-3：无 readback 路线对比验证
   - 工具、实测与 Delta 结论均已回填并可复查。
5. [ ] 6B 后续：继续压缩 GPU 路径中的 CPU 参与
   - 拆分并排查必须保留的 `readback -> CPU layer -> 再回传` 依赖，形成“可删除/暂保留”清单。
   - 先落地低风险链路减负（不改公开行为），再评估默认路径切换条件。
   - [x] 依赖清单已完成（2026-02-06，单层 no-readback 现状）：
     - `热路径已达成`：单层 GPU `commit` 默认 `readbackMode=disabled`，抬笔提交不再阻塞同步 readback。
     - `必须保留（当前）`：
       - `captureBeforeImage -> syncGpuLayerForHistory`（起笔前同步待回写 tile，保证 undo 基线正确，不跨笔撤销）。
       - `handleUndo/handleRedo/clear/fill` 相关历史路径前的 `syncGpuLayerForHistory`（历史栈仍以 CPU `ImageData` 为事实源）。
     - `条件保留（模式切换一致性）`：
       - `syncGpuLayerToCpu` 在 GPU 显示退出或图层切换时执行一次，确保 Canvas2D fallback 画面一致。
       - 关闭 pilot / 手动切回 `readbackMode=enabled` 时的 `syncAllPendingGpuLayersToCpu` 补齐。
     - `候选移除（下一阶段）`：
       - 调试态 `readbackMode=enabled` 主分支与对应全局切换 API（仅 A/B 与门禁工具使用，非默认绘画链路）。
       - 自动调度 `schedulePendingGpuCpuSync` 的“每笔后异步回写”策略（待历史链路去 CPU 化后替换）。
6. [ ] 多层可见性能说明与下一阶段方案
   - 补齐“单层 GPU / 多层 fallback”边界说明与用户可见影响。
   - 输出 M3 入口条件与最小实现范围（tile 化多层合成路径）。
7. [ ] 回归验收（自动回放 + 手工抽检，封版前窗口执行）
   - 6A 仍保持 `PARTIAL PASS`，最终发布前必须完成全量门禁复验。

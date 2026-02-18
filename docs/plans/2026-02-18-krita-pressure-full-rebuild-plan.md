# 画笔压感全链路重建计划（Full Rebuild，严格对齐 Krita）

**日期**：2026-02-18  
**状态**：可执行方案（审查增强版）  
**决策**：不再修补旧实现，采用“全量重建 + 影子对比 + 一次切换”

---

## 0. 直接结论（含计划置信度）

1. 这份计划的目标是：重建 Sutu 压感数值链路，使 `输入 -> PaintInfo -> 采样插值 -> 传感器组合 -> Dab` 的行为与 Krita 对齐。
2. 原计划可执行度不够，核心问题是“门禁有框架但缺少可直接执行的前置冻结、脚本入口、契约样例和阶段退出条件”。
3. 本版已补齐：
   - 强制前置检查（文件存在性 + hash 冻结）
   - 分阶段输入/输出/验证命令/退出门禁
   - 契约字段与单位约束
   - 门禁产物 schema 与阈值治理流程
   - 影子模式切换策略与回滚口径
4. 计划置信度（可按文档直接执行并得到明确结论）：
   - 优化前：`0.63`
   - 优化后：`0.86`
5. 仍存在的剩余不确定性（已显式纳入执行步骤）：
   - Krita 冻结基线是否覆盖足够设备/采样率分布
   - 高速窗口阈值需要通过多轮基线统计冻结

---

## 1. 目标、非目标与成功标准

### 1.1 目标

1. 重建压感数值主链路，严格对齐 Krita 语义（不是视觉“看起来差不多”）。
2. 达成四个核心场景一致：`slow_lift / fast_flick / abrupt_stop / low_pressure_drag`。
3. 保持现有 GPU-first 渲染架构，仅替换输入数值核心。
4. 保持低延迟目标：Wacom 输入链路不引入显著额外延迟，端到端体验维持 `< 12ms` 目标。

### 1.2 非目标

1. 不改 Krita 源码。
2. 不在本轮重做 Brush UI 或新笔刷特性。
3. 不在本轮做 iPad 适配实现，仅冻结跨端契约。

### 1.3 成功标准（全部满足）

1. `stage_gate=pass`
2. `final_gate=pass`
3. `fast_gate=pass`
4. 手测矩阵通过：尾段衰减、低压可控性、高速稳定性与 Krita 无明显差异
5. `pnpm check:all` 与 `cargo check --manifest-path src-tauri/Cargo.toml --lib` 通过

---

## 2. Source of Truth 与前置阻塞检查

### 2.1 Source of Truth

1. 算法真值：`docs/research/2026-02-18-krita-wacom-pressure-full-chain.md`
2. 门禁规范：`docs/testing/krita-pressure-full-gate-spec.md`
3. 场景定义：`docs/testing/krita-pressure-full-test-cases.md`
4. 冻结基线资产：Krita 导出产物（非 Sutu 自生成）

### 2.2 前置阻塞检查（不通过则禁止进入 Phase 1）

1. 必需文档存在：
   - `docs/testing/krita-pressure-full-gate-spec.md`
   - `docs/testing/krita-pressure-full-test-cases.md`
2. 必需输入文件存在且可 hash：
   - `debug-stroke-capture.json`（固定路径或固定复制副本）
3. 基线版本可追溯：
   - Krita 版本号
   - 设备型号与驱动版本
   - OS 版本
4. 同输入重复 10 次导出，结构 hash 一致（允许 run_meta 时间戳字段不同）

---

## 3. 重建原则（防止再次修补失败）

1. **旧链路不是约束**：允许删改旧压感实现。
2. **先冻结契约再编码**：字段、单位、边界处理先定稿。
3. **阶段失败优先修阶段**：禁止直接调最终像素阈值。
4. **阈值治理不可临时放宽**：失败后不能“改阈值硬过”。
5. **单位统一**：内部时间 `us`，报告 `ms`；压感统一 `[0,1]`。
6. **语义命名正向化**：Sutu 内部使用 `pressureEnabled` 正向语义；Krita 历史反直觉布尔命名仅在基线对齐层处理。

---

## 4. 目标链路（Krita 对齐）

### 4.1 逻辑链路

1. `RawInputSample`（x/y/pressure/tilt/timestamp/phase/source）
2. `GlobalPressureCurve`（LUT 1025 + 线性查询）
3. `SpeedSmoother`（首点 0，filtered mean 时间差）
4. `PaintInfoBuilder`（pressure + drawingSpeed + time）
5. `SegmentSampler`（spacing/timing + distance/time carry）
6. `PaintInfoMix`（pressure/speed/time 同步线性插值）
7. `DynamicSensor`（LUT 256 二级曲线）
8. `CurveOptionCombiner`（multiply/add/max/min/difference）
9. `DabEmitter`（输出给 GPU dab 提交）

### 4.2 必须对齐的算法语义

1. 全局曲线：`floatTransfer(1025)` + 线性插值。
2. 速度：`totalTime = avgDt * usedSamples`（不是真实 dt 逐点和）。
3. 采样：由 spacing/timing 决定，保留 carry。
4. 插值：`pressure/speed/time` 同时按 `t` 线性 mix。
5. 传感器：二级 LUT 映射后再组合。

---

## 5. 契约冻结（Implementation Contract）

## 5.1 核心数据结构（字段冻结）

1. `RawInputSample`
   - `x_px: number`
   - `y_px: number`
   - `pressure_01: number`
   - `tilt_x_deg: number`
   - `tilt_y_deg: number`
   - `rotation_deg: number`
   - `device_time_us: number`
   - `host_time_us: number`
   - `phase: 'down' | 'move' | 'up' | 'hover'`
   - `source: 'wintab' | 'mac_native' | 'pointer_event'`
2. `PaintInfo`
   - `x_px`
   - `y_px`
   - `pressure_01`
   - `drawing_speed_01`
   - `time_us`
3. `DabRequest`
   - `x_px`
   - `y_px`
   - `size_px`
   - `flow_01`
   - `opacity_01`
   - `time_us`
4. `GateArtifact`
   - `run_meta`
   - `input_hash`
   - `baseline_version`
   - `stage_metrics`
   - `final_metrics`
   - `fast_windows_metrics`
   - `summary`

## 5.2 单位与边界处理

1. 压感 clamp 到 `[0,1]`。
2. 速度归一化 clamp 到 `[0,1]`。
3. 时间内部统一 `us`，报告输出 `ms`。
4. `first_point` 速度固定为 `0`。
5. 时间戳突变（回退或超大间隔）写入 `anomaly_flags`，并进入门禁统计。

---

## 6. 新模块落位与现有代码接线

### 6.1 新增模块（目标）

1. `src/engine/kritaPressure/core/types.ts`
2. `src/engine/kritaPressure/core/globalPressureCurve.ts`
3. `src/engine/kritaPressure/core/speedSmoother.ts`
4. `src/engine/kritaPressure/core/paintInfoBuilder.ts`
5. `src/engine/kritaPressure/core/segmentSampler.ts`
6. `src/engine/kritaPressure/core/paintInfoMix.ts`
7. `src/engine/kritaPressure/core/dynamicSensor.ts`
8. `src/engine/kritaPressure/core/curveOptionCombiner.ts`
9. `src/engine/kritaPressure/pipeline/kritaPressurePipeline.ts`
10. `src/engine/kritaPressure/testing/gateRunner.ts`
11. `src-tauri/src/core/contracts/pressure_v1.rs`

### 6.2 必改接线点（现有文件）

1. `src/components/Canvas/useStrokeProcessor.ts`（改为调用新 pipeline）
2. `src/components/Canvas/inputUtils.ts`（输入字段适配到 `RawInputSample`）
3. `src/stores/tablet.ts`（保持 `device_time_us/host_time_us` 透传）
4. `src/utils/pressureCurve.ts`（迁移为 Krita 对齐曲线实现或仅保留 UI 编辑用途）
5. `src/utils/brushSpeedEstimator.ts`（替换为 Krita 语义实现或降级为 compatibility wrapper）

---

## 7. Implementation Plan（分阶段可执行）

## Phase 0：冻结对比口径（Gate 前置）

目标：锁定输入、画布、笔刷、导出 schema。

执行项：

1. 固定输入文件并记录 `sha256`。
2. 固定画布参数：尺寸、DPI、缩放、背景。
3. 固定笔刷参数：`size/spacing/flow/opacity/hardness + sensor settings`。
4. 固定导出 schema：`stage/final/fast/summary`。
5. 冻结诊断最小字段（写入 `summary.json`），不依赖外部诊断模板文件。

输出：

1. `docs/testing/krita-pressure-baseline-freeze-v1.md`
2. `artifacts/krita-pressure-full/baseline/<baseline_version>/meta.json`

退出门禁：

1. 同输入重复 10 次，除 `run_id/time` 外 hash 一致。
2. 缺字段或未登记字段变更即 fail。

## Phase 1：冻结契约与数值规范

目标：把“字段、单位、边界语义”锁死。

执行项：

1. 定义 `RawInputSample/PaintInfo/DabRequest/GateArtifact`。
2. 新增 `pressure_v1.rs` 与 TS 对齐定义。
3. 增加契约 roundtrip 测试（TS <-> Rust）。
4. 定义异常标记：`timestamp_jump / non_monotonic_seq / invalid_pressure`。

输出：

1. `src-tauri/src/core/contracts/pressure_v1.rs`
2. `src/engine/kritaPressure/core/types.ts`
3. 契约测试文件（TS + Rust）

退出门禁：

1. 契约评审通过。
2. 契约测试全绿。

## Phase 2：重建 Input -> PaintInfo

目标：完成全局压感和速度链路。

执行项：

1. 实现 LUT 1025 全局曲线与线性采样。
2. 实现 Krita 语义 `SpeedSmoother`。
3. 构建 `PaintInfoBuilder` 输出 pressure/speed/time。
4. 输出阶段指标：`input_normalize/global_curve/speed_builder`。

退出门禁：

1. `input_normalize/global_curve/speed_builder` 全通过。
2. `low_pressure_drag` 与 `timestamp_jump` 不出现阻塞失败。

## Phase 3：重建采样、插值与 finalize

目标：对齐 dab 触发时机与尾段行为。

执行项：

1. 实现 `SegmentSampler`（spacing + timing + carry）。
2. 实现 `PaintInfoMix`（pressure/speed/time 同步插值）。
3. 实现 `finishStroke`（末段补点与末样本消费）。
4. 输出阶段指标：`sampling/mix/finalize`。

退出门禁：

1. `abrupt_stop/slow_lift` 阶段门禁通过。
2. 无末点丢样本、无尾段断压。

## Phase 4：重建动态传感器与组合

目标：对齐 size/flow/opacity 动态参数逻辑。

执行项：

1. 实现 `DynamicSensor` LUT 256 映射。
2. 实现 `CurveOptionCombiner`（至少 multiply，预留 add/max/min/difference）。
3. 对接到 `DabRequest.size/flow/opacity`。
4. 输出阶段指标：`sensor_map/curve_combine`。

退出门禁：

1. `low_pressure_drag/fast_flick` 阶段门禁通过。
2. 动态参数轨迹与基线一致。

## Phase 5：影子模式接线（不立刻切主）

目标：降低一次切换风险。

执行项：

1. 在 `useStrokeProcessor` 接入新 pipeline。
2. 增加短期开关：`pressurePipelineV2Shadow`（仅比对不出图）与 `pressurePipelineV2Primary`（新链路出图）。
3. 影子模式下输出双链路差异日志。

退出门禁：

1. 影子模式连续回放 100 次无崩溃。
2. 差异报告可定位到阶段级别。

## Phase 6：门禁自动化与报告

目标：一键得到“是否达标：是/否”。

执行项：

1. 实现 `gateRunner.ts`，输出 `stage/final/fast/summary`。
2. 固化 A~H 场景执行顺序。
3. 新增脚本入口：
   - `scripts/pressure/run-gate.mjs`
   - `scripts/pressure/check-determinism.mjs`

退出门禁：

1. 自动报告包含：`run_meta/input_hash/baseline_version/blocking_failures`。
2. 任意失败可定位到阶段和 case。

## Phase 7：阈值标定与版本治理

目标：阈值可审计、可复现。

执行项：

1. 用 Krita 基线至少 30 轮采样建立分布。
2. 生成阈值文件：`docs/testing/krita-pressure-thresholds.v1.json`。
3. 固定阈值生成公式：

```text
threshold_metric = max(
  p99(metric_delta_of_krita_vs_krita),
  metric_floor
) + safety_margin
```

4. 记录阈值变更审计（旧值/新值/原因/影响）。

退出门禁：

1. 阈值文件可追溯。
2. 无“失败后临时放宽阈值”行为。

## Phase 8：一次切换与旧链路下线

目标：新链路成为唯一生产路径。

执行项：

1. `pressurePipelineV2Primary=true` 切主。
2. 保留紧急回退开关一个迭代周期。
3. 清理旧压感核心调用与死代码。

退出门禁：

1. 生产默认只走新链路。
2. 一个迭代周期后删除回退开关。

## Phase 9：收尾与最终结论

目标：交付可审计、可复现的最终结果。

执行项：

1. 全量检查：`pnpm check:all`。
2. Rust 检查：`cargo check --manifest-path src-tauri/Cargo.toml --lib`。
3. 输出最终结论：`是否达标：是/否` + 差距 + 下一步。

---

## 8. 门禁产物与 schema（必须遵守）

### 8.1 产物目录

1. `artifacts/krita-pressure-full/<run_id>/stage_metrics.json`
2. `artifacts/krita-pressure-full/<run_id>/final_metrics.json`
3. `artifacts/krita-pressure-full/<run_id>/fast_windows_metrics.json`
4. `artifacts/krita-pressure-full/<run_id>/summary.json`

### 8.2 `summary.json` 最小字段

1. `overall`
2. `stage_gate`
3. `final_gate`
4. `fast_gate`
5. `blocking_failures`
6. `run_meta`
7. `input_hash`
8. `baseline_version`
9. `threshold_version`
10. `case_results`

### 8.3 判定规则

1. 仅当 `stage_gate=pass` 且 `final_gate=pass` 且 `fast_gate=pass` 时，`overall=pass`。
2. 任一门禁失败即 `overall=fail`。
3. 样本不足（高速窗口数不足）直接 fail，不允许降级为 warning。

---

## 9. 手测步骤（必须可按步骤复现）

1. 准备：加载 Phase 0 冻结输入与笔刷参数，确认 `input_hash` 匹配。
2. 运行自动门禁：执行 gate runner，拿到 `summary.json`。
3. 打开同一输入在 Krita 与 Sutu 的输出叠加图（含 ROI）。
4. 逐项检查：
   - `slow_lift`：尾段是否连续衰减
   - `fast_flick`：高速尾段是否异常变细/断裂
   - `abrupt_stop`：停笔末端是否出现漏样
   - `low_pressure_drag`：低压细线是否可控且连续
5. 预期结果：
   - 自动门禁三门全 pass
   - 手测四场景无 blocker

---

## 10. 失败处理顺序（固定）

1. 先修阶段门禁（公式/边界/时序）
2. 再修最终门禁（视觉结果）
3. 最后修高速门禁（稳定性与覆盖）

禁止：跳过阶段直接调最终像素指标。

---

## 11. 风险与对策

1. 风险：一次替换导致生产不可用窗口。  
   对策：先影子模式，后切主；保留单迭代应急回退。
2. 风险：Krita 基线老化或设备偏置。  
   对策：基线版本化，升级必须附完整回归。
3. 风险：只看像素，忽略中间数值错误。  
   对策：阶段门禁 + 最终门禁双阻塞。
4. 风险：高速样本不足导致假阳性。  
   对策：高速窗口最小数量门槛，不足直接 fail。
5. 风险：布尔命名语义反转再次引入分支错误。  
   对策：Sutu 内部统一正向命名，适配层单独处理 Krita 历史语义。

---

## 12. Implementation Plan（执行摘要）

1. 先冻结（输入/画布/笔刷/schema/hash）。
2. 再锁契约（TS + Rust + 单测）。
3. 分三段重建核心链路（Input->PaintInfo、采样插值、动态传感器）。
4. 影子模式跑通后再切主。
5. 门禁自动化与阈值治理完成后，给最终达标结论。

---

## 13. Task List（可直接执行）

1. [ ] 冻结诊断最小字段规范并写入 gate 产物 schema（`summary.json`）。
2. [ ] 冻结输入/画布/笔刷/导出 schema，并登记 `sha256`。
3. [ ] 新建 `docs/testing/krita-pressure-baseline-freeze-v1.md`。
4. [ ] 定义并冻结 `RawInputSample/PaintInfo/DabRequest/GateArtifact`。
5. [ ] 新建 `src-tauri/src/core/contracts/pressure_v1.rs`。
6. [ ] 新建 `src/engine/kritaPressure/core/types.ts`。
7. [ ] 实现 `globalPressureCurve.ts`（LUT 1025 + 线性采样）。
8. [ ] 实现 `speedSmoother.ts`（Krita 语义）。
9. [ ] 实现 `paintInfoBuilder.ts`。
10. [ ] 实现 `segmentSampler.ts`（spacing/timing/carry）。
11. [ ] 实现 `paintInfoMix.ts`。
12. [ ] 实现 `dynamicSensor.ts`（LUT 256）。
13. [ ] 实现 `curveOptionCombiner.ts`。
14. [ ] 实现 `kritaPressurePipeline.ts`。
15. [ ] 接线 `useStrokeProcessor.ts` 与 `inputUtils.ts`。
16. [ ] 增加影子模式开关 `pressurePipelineV2Shadow/Primary`。
17. [ ] 实现 `src/engine/kritaPressure/testing/gateRunner.ts`。
18. [ ] 新增脚本 `scripts/pressure/run-gate.mjs`。
19. [ ] 新增脚本 `scripts/pressure/check-determinism.mjs`。
20. [ ] 跑 A~H 场景并输出 artifacts。
21. [ ] 生成 `docs/testing/krita-pressure-thresholds.v1.json`。
22. [ ] 执行影子模式 100 次回放稳定性验证。
23. [ ] 一次切换到新链路并观察一个迭代周期。
24. [ ] 删除旧压感核心路径与死代码。
25. [ ] 执行 `cargo check --manifest-path src-tauri/Cargo.toml --lib`。
26. [ ] 执行 `pnpm check:all`。
27. [ ] 输出最终结论：`是否达标：是/否` + 差距 + 下一步。

---

## 14. Thought（关键判断依据）

1. 旧链路反复修补失败，说明问题是系统语义偏差，而非局部 bug。
2. Krita 压感是“多阶段耦合系统”，单点对齐不会稳定达标。
3. 必须把“可复现基线 + 阶段门禁 + 最终门禁 + 高速门禁 + 阈值治理”作为一个整体交付。
4. 影子模式先对齐、再切主，可显著降低一次替换风险。

---

## 15. 参考

1. `docs/research/2026-02-18-krita-wacom-pressure-full-chain.md`
2. `docs/research/2026-02-18-krita-wacom-pressure-one-page.md`
3. `docs/testing/krita-pressure-full-gate-spec.md`
4. `docs/testing/krita-pressure-full-test-cases.md`
5. `docs/testing/cross-platform-core-consistency-v1.md`

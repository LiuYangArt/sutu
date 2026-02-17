# Krita 压感视觉一致性后续计划（Pressure-Only 严格一致专项）

**日期**：2026-02-17  
**状态**：已终止并回退（回退基线：`667152f`，仅保留文档）  
**关联文档**：
- `docs/plans/2026-02-17-krita-pressure-tail-parity-plan.md`
- `docs/research/2026-02-17-krita-pressure-chain-analysis-no-trajectory-smoothing.md`
- `docs/testing/krita-tail-gate.md`
- `docs/postmortem/2026-02-17-krita-pressure-visual-parity-rollback.md`

---

## 当前进度快照（2026-02-17 20:43）

### A. 已完成（可复现）

1. 5A 工具链主改造已落地（trace v2、语义前置检查、strict profile、后端 blocking）。
2. 5B 起笔语义改造已落地（旧起笔逻辑实验开关保留，默认关闭）。
3. Krita v2 基线采集链路打通，四个 case 已导出为 v2：
   - `tests/fixtures/krita-tail/krita-baseline/slow_lift/trace.krita.json`
   - `tests/fixtures/krita-tail/krita-baseline/fast_flick/trace.krita.json`
   - `tests/fixtures/krita-tail/krita-baseline/abrupt_stop/trace.krita.json`
   - `tests/fixtures/krita-tail/krita-baseline/low_pressure_drag/trace.krita.json`
4. 四个 case 基线文件均满足最小有效性（`schemaVersion=krita-tail-trace-v2`，`dab_emit[].sizePx > 0`）。

### B. 本轮实测结果（证据）

1. Gate 运行结果：`debug_output/krita-tail-gate/2026-02-17T12-43-46-239Z/summary.json`
2. 总结：
   - `overall_passed=false`
   - 三后端均为 `mode=blocking`
   - 三后端 `semanticFailures=0`（语义项全通过）
   - 三后端 4/4 case 均存在 `numericFailures`（数值项未收口）
3. 代表性失败簇：
   - `head_pressure_mae / head_pressure_p95`
   - `stroke_width_profile_emd`
   - `sampler_t_missing_ratio`
   - `dab_tail_count_delta / dab_tail_mean_spacing_delta_px`

### C. 结论（当前阶段）

1. 计划方向正确，且已从“无基线可测”推进到“可稳定产出 strict FAIL 向量”。
2. 当前可以继续推进原计划，不需要新增人工流程。
3. 尚不满足最终“严格一致通过”验收，卡点在数值收口（不是语义漏检）。

---

## 0. 范围冻结（先对齐共识）

### 0.1 本专项唯一目标

在 **不引入、不依赖、不讨论轨迹平滑（smoothing）** 的前提下，使 PaintBoard 的**压感链路输出**达到与 Krita 的语义等价与量化一致。

### 0.2 明确排除项（继续排除，且不回流）

1. Tool Options `Brush Smoothing`（`NONE/BASIC/WEIGHTED/STABILIZER/PIXEL`）及其参数。
2. 任何“通过改轨迹让压感看起来更顺”的兜底方案。
3. speed slider 调参专项（`Maximum brush speed` / `Brush speed smoothing`）作为当前判定主变量。

### 0.3 不可混淆原则（硬约束）

1. smoothing 只影响轨迹，不是压感真值来源；本专项不把 smoothing 作为解释或修复手段。
2. 若某改动只有在开启 smoothing 才“看起来正确”，则判定该改动**未解决压感一致性问题**。
3. 所有验收结论必须可在 `Brush Smoothing = None` 下复现。

### 0.4 “严格一致”可达定义（避免不可达表述）

1. 本专项的“严格一致”指：**语义等价 + 指标达标 + 视觉稳定复现**。
2. 不把“逐事件逐浮点位完全相等”作为目标；跨框架事件采样率、时间戳精度与浮点路径存在系统级差异。
3. 最终结论以 strict profile 下的量化阈值与重复性报告为准，不使用“完全一致（bitwise identical）”措辞。

---

## 1. 背景与当前结论

### 1.1 用户侧现象（已确认）

1. 抬笔飞线到远点再连回的问题已修复。
2. 当前主要问题是：起笔与收笔视觉不顺滑，和 Krita 对照仍明显不一致。
3. 现有 gate 报告可 PASS，但肉眼和截图质量不达标。

### 1.2 根因归类（结论）

1. **实现差异**：起笔阶段仍有非 Krita 语义的本地过渡逻辑。
2. **测试覆盖差异**：现有对比器偏 tail，未覆盖 head 与整笔压力几何。
3. **阈值治理差异**：阈值可被“现状校准”拉宽，导致假通过。

---

## 2. “压感严格一致”定义（本专项验收口径）

### 2.1 语义一致（Blocking，先判）

满足以下全部条件才允许进入数值 gate：

1. 起笔无本地特供分支：无最小位移门槛阻断、无起笔人工 ramp、无非 buildup 首压强制归零。
2. 压感插值语义与 Krita 一致：段内 pressure 采用线性插值（`mix` 语义）。
3. 收笔消费语义一致：`pointerup` 末样本补读与 fallback 策略固定且可追踪。
4. finalize 与常规采样使用同一推进器语义，不做“收笔专用近似”。

### 2.2 数值一致（Blocking，后判）

同输入重放、同 pressure-only 画笔、同后端下，`head/body/tail` 全窗口指标同时达标：

1. head：首段压感绝对误差与连续性。
2. body：整笔压力分布与宽度轮廓。
3. tail：末段压力、间距、收束斜率与末样本完整性。

### 2.3 视觉一致（Blocking，压感域）

1. 相同 case 重复 10 次，首尾过渡不出现分段突变。
2. 与 Krita 对照时，不出现“首段突粗/突细、尾段尖点断层、局部收束跳变”。
3. 视觉结论必须被数值指标支持，不允许“只靠主观描述判通过”。

### 2.4 量化上限（v1，Pressure-Only 收口值）

以下上限用于最终 strict 收口（不足以支撑视觉一致时可收紧，不可放宽后直接宣称完成）：

1. `head_pressure_mae <= 0.020`
2. `head_pressure_p95 <= 0.050`
3. `head_pressure_jump_p95 <= 0.080`
4. `body_pressure_emd <= 0.040`
5. `stroke_width_profile_emd <= 0.060`
6. `tail` 维度沿用 strict 阈值（且 `terminal_sample_drop_count == 0`）

---

## 3. 与 Krita 的主要差异锚点（当前）

### 3.1 起笔语义差异（高优先级）

1. `MIN_MOVEMENT_DISTANCE` 起笔门槛：`src/utils/strokeBuffer.ts:1412`
2. 未达门槛前不出正常采样 dab：`src/utils/strokeBuffer.ts:1848`
3. 非 buildup 起始压力置 0：`src/utils/strokeBuffer.ts:1747`
4. `appendStrokeStartTransitionDabs()` 人工压力 ramp：`src/utils/strokeBuffer.ts:1611`、`src/utils/strokeBuffer.ts:1863`

Krita 对应锚点：
- `getNextPointPosition()`：`F:/CodeProjects/krita/libs/image/brushengine/kis_paintop_utils.h:67`
- `KisPaintInformation::mix()`：`F:/CodeProjects/krita/libs/image/brushengine/kis_paintop_utils.h:68`、`F:/CodeProjects/krita/libs/image/brushengine/kis_paint_information.cc:619`
- `paintAt()`：`F:/CodeProjects/krita/libs/image/brushengine/kis_paintop_utils.h:84`

### 3.2 Gate 覆盖不足与阈值偏宽（工具问题）

1. 现有 `compareKritaTailTrace()` 主要围绕 tail：`src/test/kritaTailTrace/compare.ts:98`、`src/test/kritaTailTrace/compare.ts:174`
2. 当前阈值校准基于 `mean + 3 * std`：`scripts/debug/calibrate-krita-tail-thresholds.mjs:400`、`scripts/debug/calibrate-krita-tail-thresholds.mjs:420`
3. `thresholds.json` 存在显著偏宽值（如 count/spacing）：`tests/fixtures/krita-tail/thresholds.json`
4. 非 WinTab 后端目前默认 `warning_allowed`：`scripts/debug/gate-krita-tail.mjs:198`、`scripts/debug/gate-krita-tail.mjs:549`

### 3.3 CLI 路径与配置风险

`--thresholds` 当前按 `path.resolve(fixturesDir, cli.thresholds)` 解析，仓库相对路径易被错误拼接：`scripts/debug/gate-krita-tail.mjs:484`

### 3.4 仍需收敛的 Krita 语义细节（新增）

1. `needsSpacingUpdate` / `needsTimingUpdate`（`kis_paintop_utils.h:97-102`）：
   - 当前 Pressure-Only 基线通常为固定 spacing/timing，本专项先冻结为固定配置。
   - 但需在语义检查中显式确认“本轮 case 未触发动态 spacing/timing”，避免误把 scope 外差异混入结论。
2. 首 dab `lastDabInfoValid=false` 路径：
   - 该路径会影响首段第一次循环与首 dab 输出。
   - 需补充 head 场景与语义检查，确保首 dab 处理不被本地初始化逻辑改写。

---

## 4. Gate v2 设计（先让工具“会报真错”）

### 4.1 三窗口切片规则（固定）

1. `head`：前 `max(20 dab, 15% 弧长)`
2. `body`：中间弧长窗口（剔除 head/tail）
3. `tail`：后 `max(20 dab, 15% 弧长)`

### 4.2 指标集合（Pressure-Only）

保留 tail 现有指标，并新增 head/body 指标：

1. `head_pressure_mae`
2. `head_pressure_p95`
3. `head_pressure_jump_p95`（首段相邻 dab 压差 p95）
4. `body_pressure_emd`（body 段 pressure 分布 EMD）
5. `stroke_width_profile_emd`（按弧长重采样后的宽度轮廓 EMD）
6. `head_tail_curvature_delta`（首尾切线/曲率变化差）
7. `terminal_sample_drop_count`（继续强制 0）

### 4.3 语义前置检查（短路失败）

新增 `semantic_checks`，任一失败直接 FAIL，不进入数值阈值判定：

1. `no_start_transition_ramp`
2. `no_start_distance_gate`
3. `no_forced_zero_initial_pressure_non_buildup`
4. `linear_pressure_mix`
5. `pointerup_fallback_policy_matches_spec`
6. `pressure_only_scope_has_no_dynamic_spacing_update`
7. `first_dab_path_matches_lastDabInfoValid_semantics`

### 4.4 失败策略（统一）

1. 所有后端 `rawPassed=false` 一律视为失败，不得静默转 warning 通过。
2. `warning_allowed` 仅用于阶段报告展示，不可作为最终验收结果。
3. `terminal_sample_drop_count > 0` 继续全后端硬失败。

### 4.5 阈值治理（防“校准放水”）

1. 增加严格阈值文件：`tests/fixtures/krita-tail/thresholds.strict.json`
2. 校准默认输出到：`tests/fixtures/krita-tail/thresholds.calibrated.json`，不直接覆盖 strict 文件。
3. 校准输出必须包含完整 `stats`；若为空、缺字段或样本不足直接报错退出。
4. 任何阈值放宽都需单独评审，且必须附“旧阈值 FAIL / 新阈值 PASS / 视觉对照”三联证据。
5. 增加异常保护：若三后端阈值完全一致且持续出现，脚本输出 `suspicious_threshold_profile` 警告并拒绝写入 strict。

### 4.6 指标计算口径（防“同名不同算”）

1. `head/body/tail` 按弧长切片，先重采样到相同长度再计算分布型指标（EMD）。
2. `stroke_width_profile_emd` 基于弧长归一化后的宽度序列（0..1）计算，禁止直接按原始 dab 索引比较。
3. `head_pressure_jump_p95` 仅在 head 窗口内计算相邻 dab 压差，不跨窗口取样。
4. 指标实现与文档定义不一致时，以文档口径为准并阻塞验收。

---

## Implementation Plan（实施方案）

### Phase 5A（P0）：工具链升级为 Gate v2（先修判定能力）

状态：已完成（首轮）

目标：保证工具能稳定发现 head/body/tail 的真实差异。

任务：
1. 扩展 `src/test/kritaTailTrace/compare.ts` 三窗口 + 新指标 + semantic checks。
2. 修复 `scripts/debug/gate-krita-tail.mjs` 的失败策略与 `--thresholds` 路径解析。
3. 升级 `scripts/debug/calibrate-krita-tail-thresholds.mjs`：强制输出 `stats`、校准输出与 strict 分离。
4. 增加首 dab 与动态 spacing/timing 的语义检查（Pressure-Only 作用域冻结 + 触发标记）。
5. 更新 `docs/testing/krita-tail-gate.md` 运行与验收说明。

完成标准：
1. 现有已知坏样本在 strict gate 下稳定 FAIL。
2. 自检用例覆盖 `v1/v2` 兼容、strict/calibrated 两套阈值路径。
3. `summary.json` 可区分“语义失败”和“数值失败”。
4. `summary.json` 明确记录首 dab 路径检查结果与动态 spacing/timing 触发标记。

### Phase 5B（P0）：起笔语义收敛到 Krita

状态：已完成（首轮）

目标：去除起笔非 Krita 分支，统一采样推进语义。

任务：
1. 移除/默认禁用 `appendStrokeStartTransitionDabs()`。
2. 移除 `MIN_MOVEMENT_DISTANCE` 对正常起笔输出的硬阻断（如保留仅实验开关且默认关）。
3. 非 buildup 模式取消“首压强制 0 + 人工 ramp”。
4. 起笔/常规/收笔统一进入同一采样推进器。
5. 保持已修复的 pointerup 防飞线逻辑不回退。

完成标准：
1. semantic checks 中所有起笔项全部 PASS。
2. 首段连续性单测覆盖“慢起笔/快甩起笔/低压起笔”。

### Phase 5C（P1）：重建基线与阈值（按后端分组）

状态：进行中（已完成真实基线导出与 strict 首轮验证，待数值收敛）

目标：形成可复现、可回归的严格基线。

任务：
1. 固定 strict profile 后先跑全后端 gate，预期先 FAIL（诊断基线）。
2. 起笔修复后重建 baseline trace（按 `windows_wintab/windows_winink_pointer/mac_native` 分组）。
3. 执行 10 轮校准，仅用于微调 calibrated 文件，不得覆盖 strict。
4. 输出对比报告、差异图和人工复测模板。

完成标准：
1. `windows_wintab` 达到 blocking 全绿。
2. `windows_winink_pointer`、`mac_native` 至少 `rawPassed=true`，且不依赖 warning 通过。

### Phase 5D（P1）：Pressure-Only 严格收口

状态：待开始（依赖 5C 数值收口）

目标：把“压感严格一致”收口为可交付结论。

任务：
1. 增加 10 次重复性报告：同 case 重放下 head/tail 方差与 Krita 同量级。
2. 输出最终审计包：语义检查报告 + 数值 gate 报告 + 对照录屏索引。
3. 固化回归命令到 CI/本地脚本，防止后续回退。

完成标准：
1. 语义/数值/人工三层验收全部通过。
2. 在 `Brush Smoothing = None` 下复跑结论不变。

---

## Task List（任务清单）

1. 工具链（P0）：
   - 扩展 `compare.ts` 到三窗口和新指标；
   - 增加 `semantic_checks` 短路失败；
   - 增加首 dab 与动态 spacing/timing 语义检查；
   - 修复 gate/calibrate 路径与阈值治理逻辑。
2. 实现链路（P0）：
   - 去除起笔人工过渡与硬门槛；
   - 统一采样推进路径；
   - 维持 pointerup 防飞线修复不回退。
3. 自动化验证（P0）：
   - `pnpm -s typecheck`
   - `pnpm -s vitest run src/utils/freehand/__tests__/segmentSampler.test.ts src/utils/__tests__/brushStamper.speedTail.test.ts src/components/Canvas/__tests__/usePointerHandlers.test.ts src/test/kritaTailTrace/kritaTailTrace.test.ts`
4. Gate 验证（P1）：
   - strict profile 全后端 gate（先 FAIL 作为基线）；
   - 修复后全后端 gate（目标 PASS）；
   - 10 轮校准并审查 `stats` 完整性与合理性。
5. 人工验收（P1）：
   - 同设备同笔刷同画布录制 Krita/Sutu 对照；
   - 按模板检查首段过渡、末段收束、整笔连续性；
   - 重复 10 次记录方差并归档。

---

## 5. 验收标准（升级版）

### 5.1 自动化验收（必须）

1. `semantic_checks` 全通过（任一失败即 FAIL）。
2. `head/body/tail` 三窗口指标全部满足 strict 阈值。
3. `windows_wintab` blocking 全绿。
4. `windows_winink_pointer` 与 `mac_native` 均 `rawPassed=true`，不得仅靠 warning。
5. `terminal_sample_drop_count == 0` 全后端保持强制约束。
6. `pressure_only_scope_has_no_dynamic_spacing_update` 与 `first_dab_path_matches_lastDabInfoValid_semantics` 必须为 PASS。

### 5.2 人工验收（必须）

1. 起笔无突粗/突细分段感。
2. 收笔无断层尖点、无局部收束跳变。
3. 同动作重复 10 次，形态方差与 Krita 同量级。

---

## Thought（关键判断）

1. 飞线修复只解决异常，不等于压感一致性完成。
2. 当前最大风险不是单个常数，而是“验证口径漏掉用户可见缺陷”。
3. 必须先修工具再修实现，否则会重复“报告 PASS、视觉 FAIL”。
4. 起笔人工过渡是首尾不顺滑的高概率主因，应保持最高优先级。
5. 继续排除 smoothing 是正确边界：本专项只对压感真值链路负责。

---

## 6. 执行顺序建议

1. 先做 Phase 5A（工具链升级，拿到可信 FAIL）。
2. 再做 Phase 5B（起笔语义修正，直接消除主偏差）。
3. 然后做 Phase 5C（按后端重建基线与阈值）。
4. 最后做 Phase 5D（严格收口与交付审计包）。

> 备注：如需推进轨迹平滑相关工作，必须单独立项，且不得修改本专项验收口径。

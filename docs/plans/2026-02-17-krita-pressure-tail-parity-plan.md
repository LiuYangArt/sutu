# Krita 压感尖尾一致性执行计划（当前 issue 范围）

**日期**：2026-02-17  
**当前分支**：`perf/146-krita-photoshop`  
**目标**：只解决压感尖尾一致性；当前 issue 不推进轨迹平滑与 speed 调参。
  krita压感方案分析文档： `docs/research/2026-02-17-krita-pressure-chain-analysis-no-trajectory-smoothing.md`

> 2026-02-17 Phase0 执行补充：所有 gate/校准脚本、默认配置与文档示例统一固定使用 `http://localhost:1420/`，不再使用 `127.0.0.1` 作为默认地址。

## 0. 范围与固定口径

### 0.1 In Scope（本 issue 必做）

1. 压感映射链路对齐（输入 pressure -> 最终 dab pressure）。
2. 采样触发语义对齐（distance/timing 的触发、carry、reset）。
3. 收笔末样本完整消费（快抬笔不丢尾端低压段）。
4. 自动化对比与 gate（替代高频手工回归）。

### 0.2 Out of Scope（本 issue 不做）

1. Tool Options 轨迹平滑模式对齐（`NONE/BASIC/WEIGHTED/STABILIZER/PIXEL`）。
2. Brush Smoothing UI/参数调优。
3. Tablet speed slider 调参优化（`Maximum brush speed` / `Brush speed smoothing`）。

独立文档：`docs/plans/2026-02-17-krita-trajectory-smoothing-plan.md`

### 0.3 速度参数执行口径（固定）

1. Krita 里 speed 参数不直接改 pressure；它们影响 `drawingSpeed`，再由画笔是否启用 `Speed` 传感器决定是否影响笔迹。
2. 当前尖尾对齐基线使用 Pressure-only 画笔配置，不把 speed 当主变量。
3. 当前分支运行时已隔离 speed 启发式，不读取 Tablet speed slider（UI/持久化仍保留）：
   - `src/components/Canvas/useBrushRenderer.ts:215`
   - `src/components/Canvas/useBrushRenderer.ts:818`
   - `src/components/Canvas/useBrushRenderer.ts:862`

### 0.4 冻结基线工况（复现前提）

1. Krita 画笔：Pixel Engine，`Size` 仅启用 `Pressure`，`Speed/Fade/Distance/Time` 全关闭。
2. Krita Tool Options：`Brush Smoothing = None`。
3. Sutu：轨迹平滑关闭、speed 启发式隔离开启。
4. Case 集合（固定顺序）：`slow_lift`、`fast_flick`、`abrupt_stop`、`low_pressure_drag`。
5. 画布与笔刷基线：由 Phase 0 产出的 `baseline-config.json` 固化，不允许口头约定。

---

## 1. Krita 侧源码锚点（执行顺序）

### 1.1 输入压感与速度

1. Tablet 压感曲线配置读写：  
   - `F:\CodeProjects\krita\libs\ui\kis_config.cc:1584`  
   - `F:\CodeProjects\krita\libs\ui\kis_config.cc:1601`
2. Preferences 页面项（压感曲线 + speed 设置）：  
   - `F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1645`  
   - `F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1677`  
   - `F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1692`  
   - `F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1701`
3. Builder 应用 pressure/speed：  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:128`  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:131`  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:137`  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:179`
4. Speed smoother：  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:83`  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:103`  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:149`  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:157`

### 1.2 采样触发与插值

1. `paintLine` 主循环（`getNextPointPosition` + `mix` + `paintAt`）：  
   - `F:\CodeProjects\krita\libs\image\brushengine\kis_paintop_utils.h:67`  
   - `F:\CodeProjects\krita\libs\image\brushengine\kis_paintop_utils.h:68`  
   - `F:\CodeProjects\krita\libs\image\brushengine\kis_paintop_utils.h:84`
2. 触发语义（distance/time 取最早触发）：  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:405`  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:424`  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:431`
3. 未命中/命中时累积与重置：  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:436`  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:443`

### 1.3 动态传感器

1. 传感器曲线入口：  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensor.cpp:35`  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensor.cpp:42`
2. Speed/Pressure 值来源：  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensors.h:20`  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensors.h:43`

---

## 2. Sutu 当前差异（本 issue 相关）

### 2.1 压感与采样启发式

1. EMA 压感平滑：`src/utils/strokeBuffer.ts:1432`、`src/utils/strokeBuffer.ts:1445`。
2. pressure 插值使用 smoothstep：`src/utils/strokeBuffer.ts:1558`、`src/utils/strokeBuffer.ts:1562`。
3. pressure change 触发 spacing 减半：`src/utils/strokeBuffer.ts:1694`、`src/utils/strokeBuffer.ts:1697`。
4. low pressure density boost：`src/utils/strokeBuffer.ts:1699`、`src/utils/strokeBuffer.ts:1705`。
5. 采样器为 distance/time 并集合并：`src/utils/freehand/segmentSampler.ts:54`、`src/utils/freehand/segmentSampler.ts:64`、`src/utils/freehand/segmentSampler.ts:81`。

### 2.2 收笔末样本风险

1. `finalizeStroke` 起始即清 point buffer：`src/components/Canvas/useStrokeProcessor.ts:515`、`src/components/Canvas/useStrokeProcessor.ts:517`。
2. `pointerup` 直接结束笔触，未显式补拉末样本：`src/components/Canvas/usePointerHandlers.ts:430`、`src/components/Canvas/usePointerHandlers.ts:480`。

### 2.3 已隔离项（本 issue 不执行）

1. 轨迹平滑默认关闭并隔离：
   - `src/utils/strokeBuffer.ts:1342`
   - `src/utils/strokeBuffer.ts:1377`
   - `src/components/Canvas/useBrushRenderer.ts:819`
   - `src/components/Canvas/useBrushRenderer.ts:863`
2. speed 启发式默认固定并隔离：
   - `src/components/Canvas/useBrushRenderer.ts:215`
   - `src/components/Canvas/useBrushRenderer.ts:218`
   - `src/components/Canvas/useBrushRenderer.ts:818`
   - `src/components/Canvas/useBrushRenderer.ts:862`

---

## 3. Phase 0 阻塞项：Trace 契约与 Gate（必须先落地）

### 3.1 Trace 文件结构（`krita-tail-trace-v1`）

1. 顶层结构固定：
   - `schemaVersion`
   - `strokeId`
   - `meta`
   - `stages.input_raw[]`
   - `stages.pressure_mapped[]`
   - `stages.sampler_t[]`
   - `stages.dab_emit[]`
2. `meta` 最少包含：
   - `caseId`
   - `canvas`（宽高、dpi）
   - `brushPreset`
   - `runtimeFlags`（trajectory smoothing、speed isolation、heuristics 开关）
   - `build`（app/krita commit、平台、输入后端）

### 3.2 Stage 字段协议（单位固定）

1. `input_raw`：
   - `seq`（int）
   - `timestampMs`（float, ms）
   - `x`/`y`（float, px）
   - `pressureRaw`（float, 0..1）
   - `phase`（`down|move|up`）
2. `pressure_mapped`：
   - `seq`
   - `pressureAfterGlobalCurve`
   - `pressureAfterBrushCurve`
   - `pressureAfterHeuristic`（若关闭启发式应等于上一字段）
   - `speedPxPerMs`（monitor-only）
   - `normalizedSpeed`（monitor-only）
3. `sampler_t`：
   - `segmentId`
   - `segmentStartSeq` / `segmentEndSeq`
   - `sampleIndex`
   - `t`（0..1）
   - `triggerKind`（`distance|time`）
   - `distanceCarryBefore/After`（px）
   - `timeCarryBefore/After`（ms）
4. `dab_emit`：
   - `dabIndex`
   - `segmentId`
   - `sampleIndex`
   - `x`/`y`（px）
   - `pressure`
   - `spacingUsedPx`
   - `timestampMs`
   - `source`（`normal|finalize|pointerup_fallback`）

### 3.3 对齐键与尾段窗口定义

1. `input_raw`、`pressure_mapped`：按 `seq` 对齐。
2. `sampler_t`：先按 `segmentId + sampleIndex` 对齐，缺失时按同段 `t` 最近邻补齐并打 `alignedByNearest=true`。
3. `dab_emit`：按 `dabIndex` 对齐；若总数不同，补 `missing/extra` 标记。
4. 尾段窗口固定为：
   - `max(最后20个 dab, 最后15% 弧长)`。

### 3.4 输出产物与命令

1. `trace.sutu.json`
2. `trace.krita.json`
3. `report.json`
4. `stage_diff.csv`
5. `tail_chart.png`
6. gate 命令（目标命令名）：`pnpm -s run gate:krita-tail`

### 3.5 Krita harness 落点（实操必须按锚点）

1. `pressure_mapped`：`kis_painting_information_builder.cpp` 的 `createPaintingInformation()`（`128/131/137/179`）打点导出。
2. `sampler_t`：`kis_paintop_utils.h` 的 `paintLine()` 循环（`67/68`）打点导出。
3. `dab_emit`：`paintLine()` 中 `paintAt` 调用前后（`84`）导出最终采样点。
4. 若需判定触发来源与 carry，补打点 `kis_distance_information.cpp`（`405/424/431/436/443`）。

---

## 4. 实施阶段（按顺序执行）

### Phase 0（P0）：对比基建与阈值校准

目标：拿到稳定、可重复、可 gate 的差异报告。

任务：

1. 落地 trace v1 导出器（Sutu + Krita harness）。
2. 落地对比脚本与可视化。
3. 生成 `baseline-config.json`（冻结画布/笔刷/case）。
4. 做 10 轮校准，产出 `thresholds.json`（见第 5 节规则）。

完成标准：

1. 同一输入重复运行 10 次，指标抖动在预设范围内。
2. gate 输出可稳定复现 PASS/FAIL。

### Phase 1（P0）：压感链路去启发式

目标：先去掉会把尖尾压钝的本地补偿。

任务：

1. 段内 pressure 从 smoothstep 改为线性插值。
2. EMA / pressure-change-spacing / low-pressure-density 全部可开关。
3. `kritaParityProfile` 默认关闭上述三项。
4. 用 trace 比较尾段 pressure 曲线与 dab 密度。

### Phase 2（P0）：收笔末样本完整消费

目标：快抬笔不丢尾端低压段。

任务：

1. `pointerup` 流程改为“先补读后 finalize，最后清 buffer”。
2. 引入 `seq` 水位协议：
   - 记录 `upSeqSnapshot`。
   - 仅消费 `seq > currentCursor` 的新点。
3. 引入短暂补读窗口（grace window）：
   - 推荐：`8ms`，最多 `2` 次轮询。
4. 无 native 末点时，用 `pointerup` 事件构造 `pointerup_fallback` 样本。
5. 增加快抬笔/慢抬笔/停笔抬起自动测试。

### Phase 3（P0）：采样器语义对齐 Krita

目标：`sampler_t` 分布收敛到 Krita 基线。

任务：

1. 从“distance/time 并集合并”改为“最早触发者推进”。
2. carry/reset 语义按 Krita 对齐。
3. finalize 路径复用同一采样推进器。
4. 对齐 `triggerKind`、`carryBefore/After` 差异。

---

## 5. Gate 指标与阈值（可执行）

### 5.1 阈值生成规则（一次性）

1. 在冻结基线工况下跑 10 轮。
2. 指标阈值取：`max(默认下限, mean + 3 * std)`。
3. 生成并固化到 `thresholds.json`，后续仅允许显式变更。

### 5.2 默认下限（首次可用）

1. `pressure_tail_mae <= 0.015`
2. `pressure_tail_p95 <= 0.035`
3. `sampler_t_emd <= 0.050`
4. `sampler_t_missing_ratio <= 0.030`
5. `dab_tail_count_delta <= 1`
6. `dab_tail_mean_spacing_delta_px <= 0.50`
7. `dab_tail_pressure_slope_delta <= 0.060`
8. `terminal_sample_drop_count == 0`（20 轮 stress case）

### 5.3 speed 字段策略（仅监控，不参与 gate）

1. 记录并展示：
   - `speedPxPerMs_mae`
   - `normalizedSpeed_mae`
   - `normalizedSpeed_p95`
2. 触发 warning（不 fail）：
   - `normalizedSpeed_mae > 0.15` 或 `normalizedSpeed_p95 > 0.25`
3. 只有“启用 Speed 传感器专项”才将 speed 指标升级为 gate。

---

## 6. 自动化与人工验收

### 6.1 自动化（必须全过）

1. Phase 0：trace 导出完整、schema 校验通过。
2. Phase 1：pressure 与 dab 尾段指标满足 gate。
3. Phase 2：`terminal_sample_drop_count == 0`。
4. Phase 3：`sampler_t` 指标满足 gate。

### 6.2 人工抽检（仅里程碑）

1. 场景：慢抬、快甩、急停、低压慢移。
2. 仅在 gate 失败定位、阶段合并前做抽检。

---

## 7. 当前执行顺序

1. 先做 Phase 0（没有 trace 契约与阈值，不允许改算法）。
2. 再做 Phase 1（压感钝化启发式）。
3. 再做 Phase 2（末样本消费顺序与补读协议）。
4. 最后做 Phase 3（采样器语义）。
5. 轨迹平滑与 speed 调参严格留在独立计划，不混入本 issue。

---

## 8. 2026-02-17 验证结论（基于已提交实现与本地验证）

### 8.1 验证命令与结果

1. 基础校验（通过）：
   - `pnpm -s typecheck`
   - `pnpm -s vitest run src/test/kritaTailTrace/kritaTailTrace.test.ts src/utils/freehand/__tests__/segmentSampler.test.ts src/utils/__tests__/brushStamper.speedTail.test.ts`
2. Gate 冒烟（通过）：
   - `pnpm -s run gate:krita-tail -- --url http://localhost:1420/`
   - 结果：`passed=true`（使用 `tests/fixtures/krita-tail/thresholds.json`）
3. 10 轮校准（完成）：
   - `pnpm -s run gate:krita-tail:calibrate -- --url http://localhost:1420/ --rounds 10`
   - 结果：成功产出并更新 `tests/fixtures/krita-tail/thresholds.json`
4. PASS/FAIL 复现（通过）：
   - 校准阈值下重复运行 gate 3 次，均 PASS。
   - 严格阈值（5.2 默认下限）下运行 gate，稳定 FAIL。

### 8.2 对“设计目的”的判定

1. **Phase0 设计目的已达成（工具链层）**：
   - `krita-tail-trace-v1` 契约、导出、对比、图表、报告、校准、gate 全流程可运行。
   - 能稳定复现 PASS/FAIL，满足 Phase0“可 gate、可重复”的目标。
2. **整体 issue 终态尚未达成（算法对齐层）**：
   - 当前仅证明 Phase0 基建可用；
   - 压感尖尾的实质对齐仍需继续执行 Phase1~Phase3（去启发式、末样本消费、采样器语义对齐）。
3. **结论**：
   - 当前提交可作为 Phase0 验收基线进入后续 Phase1 开发；
   - 不应将当前状态解读为“已完成 Krita 尖尾手感对齐”。

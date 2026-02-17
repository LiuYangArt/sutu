# Krita 压感收尾完全一致计划

**日期**：2026-02-17  
**目标**：将 Sutu 的压感收尾行为对齐到 Krita 主链路语义，达到“几何、压感、采样、视觉”四个层面的可验证一致。

## 1. 直接结论

现有实现已经完成了两件关键基础能力：

1. 收尾不再做末端外推补尾，已限定在最后真实 segment 内。
2. 主段与收尾段已复用同一渲染提交流程（避免“贴尾巴”独立链路）。

但距离“和 Krita 完全一致”仍有结构性差异，主要集中在：

1. 轨迹收敛模型不同（当前 midpoint 链路 vs Krita Bezier/稳定器收敛）。
2. 采样触发语义不同（当前默认始终启用 timed 采样 vs Krita 按 brush option 启用）。
3. 压感与 spacing 仍有本地启发式补偿（EMA、low-pressure density boost、pressure-change spacing）。
4. 动态传感器链不完整（缺少 Krita 的可配置 sensor-length/curve 语义）。
5. 亚像素尾端 tip 的渲染语义与 Krita 不同（当前 `<1px` 走 1px 覆盖近似）。

## 2. 当前实现 vs Krita 差异矩阵（代码事实）

| 维度 | Krita 语义 | 当前实现 | 影响 |
|---|---|---|---|
| 轨迹收敛 | `SIMPLE/WEIGHTED` 走切线+Bezier，`STABILIZER` 在抬笔时清队列收束 | `KritaLikeFreehandSmoother` 为 midpoint 链，`finishStrokeSegment()` 只补最后半段 | 尾端几何趋势接近但不等价，曲率与拖尾惯性仍有差异 |
| 采样触发 | `getNextPointPosition()` 组合 distance/timing，timing 是否启用由 brush timing option 决定 | `SegmentSampler` 始终 distance+time 联合；`maxDabIntervalMs` 默认 16ms 且未接入笔刷配置 | 低速尾端容易过密采样，产生“糊/灰/不够利落” |
| 压感插值 | `KisPaintInformation::mix()` 线性插值 | `emitSegmentDabs()` 对 pressure 用 smoothstep 插值 | 尾端压力衰减曲线与 Krita 不同，细化速度不一致 |
| 压感平滑 | 是否平滑受 smoothing 配置控制（尤其 weighted smooth pressure） | 默认启用 EMA + low-pressure adaptive | 低压段可能被额外平滑，导致尾尖“拖泥” |
| spacing 策略 | 由 spacing/timing 与 paintop 更新驱动 | 压力变化时强制 spacing*0.5，低压时再做 density boost | 尾端会额外增密，容易偏黑或偏钝 |
| 动态传感器 | Fade/Distance/Time/Speed 等可配置且有 curve/length | 仅 `ControlSource` 子集；`fadeProgress` 来自固定阈值常量（1200px/1500ms/180 dabs） | 预设等价性不足，难以“同参数同结果” |
| 抬笔终样本 | 工具层/稳定器层在 end 阶段继续收束已有事件 | PointerUp 直接结束，未单独补采“终样本”流程 | 快速抬笔时可能丢失最后一段压力下降 |
| 亚像素尾尖 | Krita 仍在同一 dab/mask 语义下计算 | `<1px` 走 `size=1 + dabOpacity*coverage` 近似 | 极细尾尖形态与透明度分布偏差 |

## 3. 一致性目标定义（DoD）

“完全一致”按以下门槛定义：

1. **几何一致**：尾端 dab 均在最后真实 segment 域内，且与 Krita 对照在同输入下曲率趋势一致。
2. **压感一致**：尾端 pressure-size 曲线与 Krita 的采样曲线形态一致（不提前钝化、不末端突降）。
3. **采样一致**：同输入序列下，尾端 dab 计数与间隔分布落在阈值内（含慢抬与快甩场景）。
4. **视觉一致**：A/B diff 热图中尾端区域误差可控（定义见 Phase 0 基线文档）。

## 4. 实施计划（按阻塞优先级）

### Phase 0（P0）：建立 Krita 对照基线与观测面

目标：先把“差异”量化，避免再靠主观观感反复改参数。

任务：

1. 固化 4 类测试输入：慢抬笔、快甩笔、短促急停、极低压慢移。
2. 输出 Krita 对照基线（同分辨率、同笔刷参数、同输入回放）。
3. 在 Sutu 增加收尾诊断快照：`segment t`、dab 序号、pressure(before/after curve)、spacing/timing 命中来源。
4. 形成一份 baseline 指标表（尾段长度、dab count、min size、tail alpha profile）。

涉及模块：

- `src/components/Canvas/useBrushRenderer.ts`
- `src/utils/strokeBuffer.ts`
- `scripts/debug/*`（新增 Krita 对照回放/比对脚本）

### Phase 1（P0）：收敛模型对齐到 Krita 工具层语义

目标：把“midpoint 近似”升级为“Krita 等价收敛”。

任务：

1. 新增 smoothing mode（`NO/SIMPLE/WEIGHTED/STABILIZER`）运行时开关，至少先落 `SIMPLE + STABILIZER`。
2. `SIMPLE` 模式对齐切线+Bezier 收敛，不再只用 0.5 midpoint 链。
3. `STABILIZER` 模式补齐“抬笔清队列 + finishing event”语义。
4. 把 smoothing 参数纳入设置与笔刷预设（后续可调 tail aggressiveness / smooth pressure）。

涉及模块：

- `src/utils/freehand/kritaLikeFreehandSmoother.ts`（重构为模式化实现）
- `src/utils/strokeBuffer.ts`
- `src/components/BrushPanel/index.tsx`（启用 smoothing 面板）
- `src/stores/tool.ts`（新增 smoothing 配置模型）

### Phase 2（P0）：采样器语义与 Krita `getNextPointPosition` 对齐

目标：解决“尾端过密/过稀”问题。

任务：

1. `SegmentSampler` 改为与 Krita 等价的 step-by-step next-point 语义（按最近触发者推进）。
2. timed spacing 从“默认总是开启”改为“由 brush timing option 决定”。
3. spacing/timing carry 的 reset 时机与更新顺序对齐 Krita。
4. 在 finalize 末段也走完全相同的 spacing/timing 更新链。

涉及模块：

- `src/utils/freehand/segmentSampler.ts`
- `src/utils/strokeBuffer.ts`
- `src/stores/tool.ts`（补 timing 配置）

### Phase 3（P0）：移除非 Krita 启发式，改为可配置策略

目标：去掉会扭曲尾端的“本地补偿”。

任务：

1. 将 `smoothstep` 压感插值改为线性插值（与 Krita `mix` 对齐）。
2. 把 `pressureChange -> spacing*0.5` 和 `low-pressure density boost` 改为可配置，Krita 对齐预设默认关闭。
3. 压感 EMA 平滑改为由 smoothing 配置驱动，不再全局默认强制启用。

涉及模块：

- `src/utils/strokeBuffer.ts`
- `src/utils/__tests__/brushStamper.*.test.ts`

### Phase 4（P1）：动态传感器链补齐（尾端参数一致）

目标：让 size/opacity/flow 的尾端变化逻辑与 Krita 传感器模型一致。

任务：

1. 新增 `speed/distance/time` 控制源，并支持每项 `length + curve`。
2. `fadeProgress` 从固定常量进度改为基于 dab 序号与传感器长度计算。
3. `distanceProgress/timeProgress` 接入真实累计值，不再只做 UI 常量归一化。
4. 主段/收尾段统一使用同一 sensor evaluation pipeline。

涉及模块：

- `src/utils/shapeDynamics.ts`
- `src/utils/transferDynamics.ts`
- `src/components/Canvas/useBrushRenderer.ts`
- `src/stores/tool.ts`

### Phase 5（P1）：终样本与亚像素尾尖对齐

目标：修复“快抬笔最后一下”与“极细尾尖”差异。

任务：

1. PointerUp 前补一次终样本消费（优先 native buffered point），再 finalize。
2. `<1px` dab 从“1px 覆盖近似”升级为真实亚像素 footprint 语义。
3. 对齐 tail tip 的 alpha 分布，避免“灰糊尖端”。

涉及模块：

- `src/components/Canvas/usePointerHandlers.ts`
- `src/components/Canvas/useStrokeProcessor.ts`
- `src/components/Canvas/useBrushRenderer.ts`
- `src/utils/maskCache.ts`
- `src/utils/strokeBuffer.ts`

### Phase 6（P0/P1）：回归门禁与验收封口

目标：防止“文档说对齐、实测又偏”再次发生。

任务：

1. 自动化：新增 Krita 对照回放门禁（输出 `A/B/diff/report.json`）。
2. 自动化：尾端统计门禁（dab count、tail length、tail alpha slope）。
3. 手测：固定 4 套动作模板，每次改动必须复测并留图。

## 5. 验收方式

### 5.1 自动化验收（必须全过）

1. `tail dabs` 全部在最后真实 segment 内。
2. 尾端 dab 分布与 Krita 基线差异在阈值内（每个场景单独阈值）。
3. `pressure-size` 尾段曲线误差不超过阈值（按采样点序列比较）。
4. GPU/CPU 同输入回放下尾端指标一致，不出现单端偏差。

### 5.2 手动验收（按步骤执行）

1. 使用同一笔刷参数，在 Sutu 和 Krita 各画 4 组（慢抬、快甩、急停、低压慢移），每组至少 5 笔。
2. 对照观察尾端：尖端长度、灰度过渡、是否出现“糊尖/钝头/贴尾巴感”。
3. 切换 GPU/CPU 路径重复同样动作，确认尾端形态趋势一致。
4. 若任一场景不通过，记录对应输入与截图并回放到自动化 case。

## 6. 风险与应对

1. 风险：引入 smoothing mode 后影响现有手感。  
   应对：新增 `krita-parity` 模式开关，先并行验证再替换默认。

2. 风险：动态传感器链补齐改动范围大。  
   应对：先实现最小闭环（fade/distance/time/speed），后补其余传感器。

3. 风险：亚像素改造影响性能。  
   应对：先 CPU 实现基准，再做 GPU 对等与性能 profiling。

## 7. 推荐执行顺序

1. `Phase 0 -> Phase 2 -> Phase 3`（先解决“采样/压感语义偏差”）。
2. `Phase 1`（收敛模型升级，替换 midpoint 近似）。
3. `Phase 4 -> Phase 5`（传感器与尾尖精修）。
4. `Phase 6`（对照门禁固化，作为后续改动防回归基线）。


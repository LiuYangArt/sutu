# Dual Brush Secondary 去 Legacy 实施计划（KritaParityInput 化）

**日期**：2026-02-19  
**状态**：Draft（待实施）  
**删除策略**：已确认“如果不用就删”，本计划包含 `BrushStamper` 物理删除
**范围**：仅处理 Dual Brush secondary 出点链路；其它“部分一致”项暂不纳入本计划  
**目标**：secondary 路径彻底移除 `BrushStamper` 运行时依赖，统一到现有 `KritaPressurePipeline` 语义

---

## 0. 直接结论

1. 当前主笔刷（primary）已走 `KritaPressurePipeline`，但 Dual Brush secondary 仍在 `src/components/Canvas/useBrushRenderer.ts:1154` 调用 `BrushStamper.processPoint(...)`，属于遗留链路。
2. 推荐方案是“**双 pipeline 并行**”：primary/secondary 各自维护 `KritaPressurePipeline` 状态，输入样本共享，spacing 与 finalize 分开配置与结算。
3. 该方案可以在不改 GPU/CPU dual mask 合成接口的前提下完成替换，风险最低、改动可审阅、回归边界清晰。
4. 迁移完成后执行物理删除：`BrushStamper` 类与其专属 legacy 测试一并清理。

---

## 1. 背景与问题定义

当前行为（简化）：
1. primary：`KritaPressurePipeline.processSample` -> `renderPrimaryDabs` -> `stampDab`
2. secondary：`BrushStamper.processPoint` -> `stampSecondaryDab`

现存问题：
1. secondary 的 spacing/timing/finalize 语义与 primary 不同，长期维护有两套心智模型。
2. `useBrushRenderer` 同时维护 pipeline 与 legacy stamper 状态，stroke 生命周期复杂度偏高。
3. `finalizeStrokeOnce` 中 secondary 仅 `finishStroke(0)`，无明确的“secondary pipeline finalize 出点”语义。

---

## 2. 方案对比（含效果/用途）

### 方案 A（推荐）：双 `KritaPressurePipeline` 并行

思路：
1. 新增 secondary pipeline 封装（或在 hook 内显式维护 second pipeline）。
2. secondary 每帧消费同一输入样本（x/y/pressure/time/source/phase）。
3. secondary 使用独立 `spacing_px`（由 dual size/roundness/spacing 计算），独立 `finalize()`。

效果/用途：
1. secondary 行为与 primary 的核心采样语义统一。
2. 仅替换 secondary 产生 dab 点的逻辑，不动后续 dual mask/GPU 合成链路。

优点：
1. 与当前架构最一致。
2. 可渐进上线（shadow -> primary）。
3. 回归测试可复用已有 pipeline 测试口径。

缺点：
1. 每样本多一次 pipeline 计算，CPU 开销略增（通常可接受）。

### 方案 B：复用 primary dabs，再做 secondary 重采样

思路：
1. secondary 不单独跑 pipeline，直接拿 primary dabs 进行二次按 spacing 取样。

效果/用途：
1. 实现快，但 secondary 与原始输入时序解耦。

缺点：
1. secondary 受 primary dab 密度影响，语义不纯，边界 case 难以对齐。
2. 后续再追 Krita 等价时需要返工。

### 方案 C：secondary 采样下沉 GPU

思路：
1. 在 GPU 端直接基于输入轨迹算 secondary spacing/timing。

效果/用途：
1. 潜在性能上限高。

缺点：
1. 研发与调试成本最高，当前阶段不符合最小风险目标。

**结论**：采用方案 A。

---

## 3. 实施范围与非目标

### 3.1 实施范围

1. `useBrushRenderer` 中 secondary 改为 pipeline 出点。
2. 删除 `useBrushRenderer` 中 secondary 的 `BrushStamper` 运行时依赖。
3. 补齐 secondary finalize 出点语义与测试覆盖。

### 3.2 非目标

1. 不改 Dual Blend 算法（`multiply/darken/...`）。
2. 不改 GPU/CPU dual mask 贴图合成实现。
3. 不处理 `speed/time sensor` 运行态接入、DisablePressure 开关、Tool smoothing 等其它 backlog 项。

---

## 4. 目标架构（变更后）

1. 输入采样：`useBrushRenderer.processPoint` 统一生成 `RawInputSample`。
2. primary pipeline：沿用现有实现。
3. secondary pipeline：使用同样输入样本，独立 spacing 配置，输出 secondary dab 点序列。
4. secondary dab 提交：继续调用 `GPUStrokeAccumulator.stampSecondaryDab` / `StrokeAccumulator.stampSecondaryDab`。
5. finalize：`primaryPipeline.finalize()` 与 `secondaryPipeline.finalize()` 都在 `finalizeStrokeOnce` 中显式消费。

---

## 5. 模块与文件改动清单（拟定）

新增：
1. `src/engine/kritaParityInput/pipeline/dualBrushSecondaryPipeline.ts`
2. `src/engine/kritaParityInput/__tests__/dualBrushSecondaryPipeline.test.ts`

修改：
1. `src/components/Canvas/useBrushRenderer.ts`
2. `src/engine/kritaParityInput/index.ts`
3. `src/components/Canvas/__tests__/useBrushRenderer.strokeEnd.test.ts`
4. `src/components/Canvas/__tests__/useBrushRendererOpacity.test.ts`（如受影响）
5. `docs/plans/2026-02-18-krita-pressure-full-rebuild-plan.md`（同步状态）

说明：
1. 本计划默认执行“运行态引用归零 -> 物理删除类定义与专属测试”，不再保留 `BrushStamper` 作为历史实现。

---

## 6. Implementation Plan（中文）

### Phase 0：基线冻结（Dual Brush 专项）

1. 固定 3 组 Dual Brush 手测场景：`slow_lift`、`fast_flick`、`abrupt_stop`（至少各 20 笔）。
2. 固定 2 套 dual preset：`parametric_secondary`、`texture_secondary`。
3. 记录现状 artifacts（截图 + stroke capture + 关键日志）。

退出条件：
1. 有可复现 baseline 包（路径固定在 `artifacts/dual-brush-secondary-baseline/<run_id>/`）。

### Phase 1：secondary pipeline 落地

1. 新建 secondary pipeline 封装，输入为 `RawInputSample + dual spacing config`。
2. 在 `useBrushRenderer` 替换 `secondaryStamperRef` 为 `secondaryPipelineRef`。
3. secondary 每帧使用同一 `source/phase/host_time_us/device_time_us` 入链。
4. secondary spacing 使用 dual 参数（`size/roundness/spacing`）独立计算。

退出条件：
1. secondary 运行时不再调用 `BrushStamper.processPoint`。

### Phase 2：finalize 与生命周期对齐

1. `beginStroke`：reset secondary pipeline。
2. `finalizeStrokeOnce`：消费 `secondaryPipeline.finalize()` 并补齐 secondary 尾段 dabs。
3. 处理 dual 开关在笔画中变化的策略（本期固定“本 stroke 锁定开关状态”）。

退出条件：
1. secondary finalize 不丢尾段；`up` 收笔可复现。

### Phase 3：测试与门禁

1. 新增 secondary pipeline 单测（spacing/timing/carry/finalize）。
2. 更新 `useBrushRenderer` 测试，移除对 `BrushStamper.finishStroke` 的耦合断言。
3. 增加 Dual Brush 回归：`dual enabled` 下 secondary dab 数量与尾段行为。

退出条件：
1. 相关单测全绿，且 `pnpm check:all` 通过。

### Phase 4：清理与收口

1. 清理 `useBrushRenderer` 中 legacy stamper 引用、无用状态和注释。
2. 物理删除 `src/utils/strokeBuffer.ts` 中 `BrushStamper` 与相关类型（如 `BrushDabPoint`、`BrushStamperInputOptions`，若无其它引用）。
3. 清理 `src/utils/__tests__/brushStamper.*.test.ts` 等专属 legacy 测试，并更新受影响断言。
4. 更新计划文档状态，标记“dual brush secondary legacy 已替换且已删除”。
5. 输出回归结论与剩余风险。

退出条件：
1. 运行态无 secondary legacy 依赖。
2. `rg -n "BrushStamper" src` 仅允许命中历史文档（不允许命中运行时代码）。

---

## 7. 验收标准（Blocking）

1. `src/components/Canvas/useBrushRenderer.ts` 中不再存在 secondary `BrushStamper` 调用。
2. Dual Brush 下 secondary dabs 由 pipeline 产出，且收笔尾段无断裂。
3. Dual Brush 关键场景手测通过：慢抬笔、快甩笔、低压拖拽。
4. `pnpm -s vitest run src/engine/kritaParityInput/__tests__/dualBrushSecondaryPipeline.test.ts` 通过。
5. `pnpm -s vitest run src/components/Canvas/__tests__/useBrushRenderer.strokeEnd.test.ts` 通过。
6. `rg -n "BrushStamper" src/components src/engine src/utils` 无运行时命中（仅允许被删除后的空结果）。
7. `pnpm check:all` 通过。

---

## 8. 风险与对策

1. 风险：双 pipeline 增加 CPU 压力。  
   对策：只在 `dualBrushEnabled=true` 激活 secondary pipeline；采样上限沿用现有 `MAX_SEGMENT_SAMPLES`。

2. 风险：texture secondary 首笔纹理未就绪。  
   对策：复用已有 `prewarmDualBrushTexture` 与 `setTextureSync` 路径，不改 preload 机制。

3. 风险：行为变化导致历史预设观感偏差。  
   对策：Phase 0 baseline 对比 + 手测矩阵；必要时提供短期实验开关用于 A/B。

---

## 9. Task List（中文）

1. [ ] 新建 `dualBrushSecondaryPipeline.ts`，封装 secondary pipeline 状态与输入输出。
2. [ ] 新增 `dualBrushSecondaryPipeline.test.ts`，覆盖 spacing/timing/carry/finalize。
3. [ ] `useBrushRenderer.ts` 删除 `secondaryStamperRef`，接入 `secondaryPipelineRef`。
4. [ ] `processPoint` 中 secondary 改为 pipeline 出点并提交 `stampSecondaryDab`。
5. [ ] `finalizeStrokeOnce` 接入 secondary finalize 出点。
6. [ ] 清理 `legacyPrimaryStamperRef` / `secondaryStamperRef` / `BrushStamper` 相关无效逻辑。
7. [ ] 删除 `src/utils/strokeBuffer.ts` 中 `BrushStamper`（及无引用附属类型）。
8. [ ] 删除或改造 `src/utils/__tests__/brushStamper.*.test.ts`。
9. [ ] 更新 `useBrushRenderer.strokeEnd.test.ts`，改为 pipeline 语义断言。
10. [ ] 增加 Dual Brush 回归测试（parametric + texture 至少各 1 例）。
11. [ ] 执行专项测试与 `pnpm check:all`。
12. [ ] 更新 `2026-02-18` 主计划文档第 18 节状态。

---

## 10. 验证命令

1. `pnpm -s vitest run src/engine/kritaParityInput/__tests__/dualBrushSecondaryPipeline.test.ts`
2. `pnpm -s vitest run src/components/Canvas/__tests__/useBrushRenderer.strokeEnd.test.ts`
3. `pnpm -s vitest run src/components/Canvas/__tests__/useBrushRendererOpacity.test.ts`
4. `pnpm check:all`

---

## 11. Thought（中文）

1. 你当前最关注的是 Dual Brush secondary 的语义一致性和长期维护成本，因此最优策略不是“修补 `BrushStamper`”，而是将 secondary 拉入同一 pipeline 体系。
2. 直接改 GPU 合成层风险高、回归面大；而“secondary 出点替换 + 合成接口不动”能把变更控制在输入采样层，风险与收益比最好。
3. 你已确认“不用就删”，因此本轮不止做“运行态断开”，还要完成 `BrushStamper` 物理删除，避免遗留代码在后续迭代反向渗透。

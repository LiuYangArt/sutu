# CPU Softness 回归与自动化对比链路复盘（2026-02-13）

**日期**：2026-02-13  
**状态**：问题已止损，CPU 软边策略已调整，自动化对比链路已补齐

## 背景

在对齐 PS 软边手感过程中，目标是先把 CPU procedural 圆头笔刷作为基线，再推进 GPU 对齐。  
用户反馈两个关键现象：

1. `hardness=50%` 时，`gaussian` 有明显 dab 感（串珠感强）。
2. 极软边缘存在末端硬裁（hard clipping）感。

## 事故经过（简版时间线）

1. 初始尝试把问题归因到像素量化，修改了 `maskCache.blendPixel()` 的写入方式（`+0.5` -> `Math.round`）。
2. 用户立即验证反馈：`gaussian` 软边明显变坏，dab 感更强。
3. 第一时间回滚该改动，确认回到修改前行为。
4. 改为先补自动化对比能力（固定 capture + 固定 seed + A/B 截图 + diff + 指标），再调整 CPU 曲线。
5. 在 `default` 基线之上做“轻微软化 + 终端 feather”策略，消除 hard clipping 并降低 dab 感。

## 根因分析

### 1) 误判根因：把“软边形状问题”当成“像素量化问题”

量化层写入（`Uint8ClampedArray`）不是这次视觉差异的主因。  
主要偏差来自 **mask profile 的形状语义**（核心区、衰减段、末端收尾）而不是 byte rounding。

### 2) 工具链缺口：回放元数据不完整

回放 capture 之前没有完整覆盖 softness 相关参数（尤其 `brushMaskType`）。  
导致“看起来在对比 A/B，实际回放参数未完全一致”的风险，降低调试置信度。

## 修复与改进

### 1) 立即止损

回滚错误改动（量化写入逻辑），避免继续放大 `gaussian` dab 感。

### 2) CPU 软边策略调整（以 default 为基线）

在 `src/utils/maskCache.ts` 中做了以下策略：

1. 新增统一软边函数：`core + exp falloff + terminal feather`。
2. `default` 保持原有性格，增加末端 feather，去除 hard clipping。
3. `gaussian` 改为“default 风格上稍软一点”的配置，而非独立旧公式分支。
4. 软边外延统一到 `1.8x`，减少末端突然截断。
5. `hardness=100%` 的硬边 AA 带由 `1.0px` 调整到 `1.2px`，更接近 PS 的微柔边。

### 3) 自动化对比链路补齐

### 新增脚本

1. `scripts/debug/replay-cpu-softness-compare.mjs`
2. `docs/debug/replay-cpu-softness-compare.md`

能力：

1. 同一 capture 在 CPU 下 A/B 回放（`mask-a` vs `mask-b`）。
2. 固定随机种子，输出 `A/B/diff/report.json`。
3. 可覆盖 `hardness/spacing/roundness/angle`。
4. 报告包含 `meanAbsDiff/maxDiff/mismatchRatio` 及软边分析指标。

### 回放元数据完善

补齐 capture 录制/回放字段：

1. `brushMaskType`
2. `brushRoundness`
3. `brushAngle`

相关文件：

1. `src/components/Canvas/index.tsx`
2. `src/components/Canvas/useGlobalExports.ts`
3. `src/components/Canvas/__tests__/useGlobalExports.test.ts`

## 验证

执行通过：

1. `pnpm exec vitest run src/components/Canvas/__tests__/useGlobalExports.test.ts src/utils/__tests__/maskCache.softnessProfile.test.ts src/utils/__tests__/strokeAccumulator.test.ts src/utils/__tests__/strokeBuffer.compositeMode.test.ts`
2. `node --check scripts/debug/replay-cpu-softness-compare.mjs`
3. `pnpm -s typecheck`

新增测试：

1. `src/utils/__tests__/maskCache.softnessProfile.test.ts`

## 经验沉淀

1. **视觉问题先建可复现实验，再改公式**：固定 capture + seed 的 A/B 脚本应先于算法调参。
2. **不要先动量化层**：软边手感偏差大多数来自 profile 形状，不是 byte 写入策略。
3. **回放元数据必须完整**：缺少 `maskType` 这类字段会让对比结果失真。
4. **调参要“锚定基线”**：本次以 `default` 为基线做小步软化，比重写整套 gaussian 更稳。

## 后续建议

1. 用同一套 capture 基线，继续做 CPU vs GPU 的 softness 参数对齐（先 `hardness=50%`，再 `hardness=100%`）。
2. 把 `replay-cpu-softness-compare` 纳入日常回归脚本集合，避免手工截图主导判断。

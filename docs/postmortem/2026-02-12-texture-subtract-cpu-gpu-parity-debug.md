# Texture Subtract CPU/GPU 一致性排查复盘（2026-02-12）

**日期**：2026-02-12  
**状态**：定位完成，业务修复待续（次日继续）

## 背景

用户反馈 `Texture -> Subtract` 在 GPU 路径有明显 dab 感，而 CPU 结果更接近预期；`Multiply` 相对正常。  
目标是先确认“不一致来源在哪条链路”，避免盲改公式。

## 现象

1. App 内手绘时，`Subtract` 的 GPU 笔触呈现明显串珠（dab）感。  
2. 同设置下，CPU 结果更连续。  
3. `Multiply` 的 CPU/GPU 视觉差异显著小于 `Subtract`。

## 排查过程与关键证据

### 1) 先确认不是“没开纹理/模式错了”

对 capture 元数据核对后，确认测试用例确实是：

1. `textureEnabled: true`
2. `textureSettings.mode: subtract`
3. `depth: 100`
4. `invert: true`

### 2) 发现一个误导项：GPU 首次回放会丢首笔

在同一环境下连续执行两次 GPU 回放，首轮与次轮墨量差异巨大（首轮极低、次轮正常），导致“看起来像公式问题”，实际先混入了管线预热问题。

结论：如果不先预热 GPU 回放，CPU/GPU 对比图可能失真。

### 3) 固定随机种子 + GPU 预热后再比较

在 `scripts/debug/replay-cpu-gpu-subtract-compare.mjs` 中加入：

1. 固定 `Math.random` 种子（默认 `424242`）
2. GPU 模式下先热身回放一次，再清层执行正式回放

得到可重复指标（同一 capture）：

1. `subtract`: `meanAbsDiff=4.7785`
2. `multiply`: `meanAbsDiff=1.6078`

这说明：排除预热噪声后，`Subtract` 仍存在更大的 CPU/GPU 差异，问题真实存在。

## 本次沉淀

1. 回放脚本必须区分用途：
   - `readback enabled/disabled` 只用于 no-readback 链路诊断；
   - `cpu/gpu` 对比用于公式与实现一致性诊断。
2. 做 GPU 回放对比前必须先预热，否则首笔缺失会污染结论。
3. 必须固定随机种子，否则 texture/spacing 抖动会放大视觉噪声。
4. 每次输出需要带 `report.json`，用数值辅助判断，不只看截图。

## 产物

1. 脚本：`scripts/debug/replay-cpu-gpu-subtract-compare.mjs`
2. 文档：`docs/debug/replay-cpu-gpu-subtract-compare.md`
3. 示例输出目录：`debug_output/texture_formula_compare/cpu_gpu_subtract_compare`

## 下一步（未在本次完成）

1. 基于已稳定的对比脚本，继续定位 `Subtract` 在 GPU shader 与 CPU 公式的逐步差异点。  
2. 对照同一 capture 做分阶段 A/B（单 dab -> 多 dab -> 累积提交）定位偏差来源。  
3. 完成业务修复后，再用脚本回归 `Subtract` 与 `Multiply` 两组基线。

---

## 2026-02-13 续：CPU 软边 `default/gaussian` 双路径对齐 GPU

### 背景

在后续调试中发现，CPU 软边路径仍保留了历史性能优化（参数容差复用 + 旧版软边近似），这会放大 CPU/GPU 对比噪声。  
由于 CPU 现阶段主要用于 debug ground truth，这类近似应移除，优先保证一致性。

### 本次修复

1. `src/utils/maskCache.ts` 的软边计算改为 GPU 公式对齐：
   - `maskType=gaussian` 对齐 `computeBrush.wgsl` 的 `compute_mask`。
   - `maskType=default` 对齐 `computeDualMask.wgsl` 的 `compute_mask`。
2. `generateMask` 的距离计算改为与 WGSL 一致的椭圆距离与旋转方向。
3. `calculateEffectiveRadius` 逻辑改为对齐 GPU 的 `calculate_effective_radius`，避免 CPU 裁剪边界与 GPU 不一致。
4. `needsUpdate` 从“容差缓存命中”改为“精确失效”（参数微小变化即重建），避免 debug 时掩码误复用。

### 验证

1. 新增测试：`src/utils/maskCache.test.ts`
   - 验证精确失效策略。
   - 验证 `gaussian/default` 两条软边曲线确实分离且有效。
2. 通过：
   - `pnpm -s test src/utils/maskCache.test.ts`
   - `pnpm -s test src/components/Canvas/__tests__/useBrushRendererOpacity.test.ts`
   - `pnpm -s typecheck`

### 经验沉淀

1. 当 CPU 仅用于 debug 时，应禁用“容差缓存”这类感知性能优化，优先可复现与可解释性。  
2. 软边对齐不能只看中心/边缘静态截图，必须同时对齐：
   - 采样坐标系（旋转方向、椭圆距离）
   - 掩码公式分支（small brush / hard brush / soft brush）
   - 有效半径（dirty rect / quick cull 边界）
3. UI 中的 `maskType` 若仅 CPU 生效而 GPU 未消费，会让“看似同参数”实际不等价；后续排查必须先确认参数是否真实进入两条链路。

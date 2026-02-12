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

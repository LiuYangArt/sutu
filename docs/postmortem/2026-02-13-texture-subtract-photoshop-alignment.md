# Texture Subtract Photoshop 对齐修复复盘（2026-02-13）

**日期**：2026-02-13  
**状态**：已修复并通过回归验证

## 背景

在 `Texture -> Subtract` 模式下，笔触出现明显 dab 分离感；同参数在 Photoshop 中表现更连续。  
上一轮排查（`2026-02-12-texture-subtract-cpu-gpu-parity-debug.md`）已确认问题真实存在，并排除了“GPU 首轮预热噪声”误导项。

## 现象

1. Subtract 模式下，单笔长线出现“串珠感”，纹理被 dab 轮廓切碎。
2. 同一套纹理参数下，Multiply 模式问题明显更轻。
3. 用户在 PS 里用“先得到连续 stroke alpha，再用 Subtract 叠纹理”的方式可得到连续结果，说明目标语义是“连续 alpha 调制”，不是“按 dab 形状切割”。

## 根因

`subtract` 的公式使用了按 base 绝对相减：

1. 旧实现：`blended = max(0, base - blend)`
2. 其中 `base` 来自每个 dab 的 tip mask（尤其软边处 base 很低）
3. 当 `blend` 偏大时，低 alpha 区域被直接扣成 0，导致纹理调制与 dab 轮廓强耦合
4. 多 dab 叠加后，视觉上被放大为明显串珠/断续感

结论：问题不在“有没有做 ceiling 调制”，而在 **Subtract 公式对低 alpha 过于激进**。

## 修复

将 Subtract 改为按 base 比例扣减：

1. 新实现：`blended = base * (1 - blend)`
2. 等价 multiplier：`multiplier = 1 - blend`（在 depth=100% 时）
3. 该形式保留了 base 的连续性，不会把软边低 alpha 区域硬截断到 0

涉及文件：

1. `src/gpu/shaders/computeBrush.wgsl`
2. `src/gpu/shaders/computeTextureBrush.wgsl`
3. `src/utils/textureRendering.ts`
4. `src/utils/textureRendering.test.ts`

## 验证

1. 自动化：`pnpm -s test -- textureRendering` 通过（11/11）。
2. 自动化：`pnpm -s typecheck` 通过。
3. 手测：用户确认 Subtract 视觉效果已对齐预期（连续度明显改善，dab 感消失）。

## 经验沉淀

1. **低 alpha 区域是 Subtract 是否“出串珠”的放大器**：绝对相减容易把软边直接打穿。
2. **Texture 混合模式对齐要先明确“作用空间”**：是按 dab 局部算，还是按连续 stroke alpha 语义算。
3. **公式对齐必须 CPU/GPU 同步提交**：否则会再次出现“某一条链路看起来好了，另一条还在漂移”。
4. **调参前先排除运行态噪声**：固定 seed + GPU 预热是纹理模式对比的前置条件。

## 后续建议

1. 继续按同方法对齐剩余 texture blend mode（先公式候选，再 capture 回放，再实笔手感确认）。
2. 为 `subtract` 增加固定 capture 的基线快照，作为后续 shader 调整的防回归锚点。

## 相关后续

`textureEachTip=false` 在非线性模式（如 `darken / colorBurn / linearBurn`）上的作用域修复见：  
`docs/postmortem/2026-02-13-texture-each-tip-off-stroke-level-alignment.md`。

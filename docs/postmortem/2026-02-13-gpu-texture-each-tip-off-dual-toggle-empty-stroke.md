# GPU Texture Each Tip Off + Dual Toggle 空笔画回归复盘（2026-02-13）

**日期**：2026-02-13  
**状态**：已修复并验证

## 背景

在上一轮把 `Texture Each Tip = Off` 改为 GPU stroke-level 语义后，用户反馈新问题：

1. GPU 下 `Texture=On` 且 `Texture Each Tip=Off` 时，`Dual Brush=Off` 无法出笔。
2. 打开 `Dual Brush` 后又可以出笔。
3. CPU 路径正常。

该现象容易误导为“blend 公式错误”，但实际是调度与资源写入时序问题。

## 现象与线索

1. 仅 GPU 受影响，CPU 不受影响，说明问题在 GPU pipeline/submit 链路。
2. 仅在 `Dual Brush=Off` 出现，`Dual Brush=On` 反而正常，说明与 `deferPost` / post pass 调度分支相关。
3. 回归点与 `Texture Each Tip Off` 的 stroke-level post pass 引入时间一致。

## 根因

根因是 **同一提交前的 uniform 覆盖**：

1. 主 dab pass 与 stroke-level texture post pass 复用了同一 pipeline uniform buffer。
2. 两个 pass 在同一个 encoder、同一次 submit 前连续执行 `queue.writeBuffer`。
3. 后一次写入（post pass 的 `dab_count=0` uniform）会覆盖前一次写入（主 dab pass 的 uniform）。
4. GPU 实际执行时主 dab pass 读到错误 uniform，导致主笔划被“吃掉/空写”。

为什么 `Dual Brush=On` 看起来正常：

1. `Dual Brush=On` 路径会走 `deferPost=true`，primary flush 阶段不会在同 encoder 内追加该 post pass。
2. 后续 dual blend 在独立 encoder/submit 里执行，避开了这次覆盖窗口。

## 修复方案

核心策略：**拆分提交边界，避免同 submit 前覆盖共享 uniform**。

1. 主 dab pass 保持原有 encoder 提交。
2. stroke-level pattern post pass 改为独立 command encoder + 独立 submit。
3. 仅当不需要 stroke-level pass 时，wet edge 才留在主 encoder；否则跟随 post encoder 执行。

涉及文件：

1. `src/gpu/GPUStrokeAccumulator.ts`

## 验证

1. `pnpm -s typecheck` 通过。
2. `pnpm -s test -- textureRendering textureDynamics textureMaskCache maskCache.softnessProfile useGlobalExports` 通过（25/25）。
3. 用户手测确认：GPU 下 `Texture=On + Texture Each Tip=Off` 时，`Dual Brush=Off` 可正常出笔。

## 经验沉淀

1. WebGPU 中“同一 queue 同步 writeBuffer + 多 pass 共用 uniform”必须谨慎，不能假设先写一定只被前一个 pass 消费。
2. 引入 post-process pass 时，优先评估是否需要独立 submit 边界，而不是只看 encoder 逻辑顺序。
3. `Dual On 正常 / Dual Off 异常` 往往意味着不是公式问题，而是调度分支和资源生命周期差异。
4. 对 GPU 回归，先排查“数据作用域 + 提交时序”，再排查 blend 公式，可显著减少误修。

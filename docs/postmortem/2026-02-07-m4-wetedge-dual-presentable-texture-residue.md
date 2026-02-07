# M4 Wet Edge / Dual Brush 白框与变深问题复盘（2026-02-07）

**日期**：2026-02-07  
**状态**：已修复

## 背景

M4 的 CPU 自动化门禁已落地，随后在手测阶段发现一个只在实时绘制中明显的视觉问题：

1. `wet edge` 绘制时，笔刷附近出现轴对齐白色矩形。  
2. 新笔触经过后，已有 `wet edge` 笔触会异常变深。  
3. `dual brush` 在 `opacity != 100%` 时也出现类似矩形与叠深问题。

这类现象会直接破坏“所见即所得”，且不应通过调宽门禁阈值规避。

## 现象与根因

### 现象

- 白框为明显的矩形区域，边界与 dirty rect / 贴图坐标对齐。  
- 问题在 `wet edge` 与 `dual brush` 路径更容易触发，普通路径不稳定复现。  
- 在 `opacity < 1` 时，历史笔触被重复叠加的视觉副作用更明显。

### 根因

根因是 **presentable 输出纹理初始化不完整 + 清理时序不稳**：

1. `wet edge` 的输出纹理 `displayTexture` 和 `dual` 的输出纹理 `dualBlendTexture` 都是“只写 dirty rect”的路径。  
2. 纹理中 dirty rect 外区域若残留旧值/未定义值，会在后续 preview/commit 被读取并参与合成。  
3. `beginStroke()` 原先清理动作发生在状态同步前；当同步过程触发纹理重建（例如 renderScale 变化）时，可能出现“先清旧纹理、后创建新纹理”的顺序，导致新纹理未被同轮清理。

最终表现为：局部矩形残留、历史像素被误参与 `source-over`，形成白框与“越画越深”。

## 修复方案

### 1) 补齐可清理能力

- `PingPongBuffer.displayTexture` 增加 `GPUTextureUsage.RENDER_ATTACHMENT`，允许 render pass clear。  
- `dualBlendTexture` 增加 `GPUTextureUsage.RENDER_ATTACHMENT`，允许显式清理。

### 2) 补齐清理对象

- `PingPongBuffer.clear()` 从仅清 `textureA/textureB`，扩展为在 `displayTexture` 已创建时一并清理。  
- `GPUStrokeAccumulator` 新增 `clearDualBlendTexture()`，用于清空 dual presentable 输出。

### 3) 修正清理时序

- `beginStroke()` 改为先同步状态（含 renderScale/wetEdge/noise），再做 GPU 清理。  
- 避免“同步导致重建后未清理”的窗口。  
- dual 路径清理按开关执行（`dualBrushEnabled`），避免不必要成本。

## 验证结果

### 自动验证

- `pnpm -s typecheck`：PASS  
- `pnpm -s test`：PASS（238 tests）

### M4 Gate（用户实测）

- 时间：`2026-02-07T05:03:22.689Z`  
- Capture：`debug-stroke-capture.json`（`AppConfig/debug-data/debug-stroke-capture.json`）  
- 阈值：`meanAbsDiff <= 3.00`，`mismatchRatio <= 1.50%`
- 结果：
  - `scatter_core`：PASS | `meanAbsDiff=0.327` `mismatchRatio=0.487%`
  - `wet_edge_core`：PASS | `meanAbsDiff=0.251` `mismatchRatio=0.442%`
  - `dual_core`：PASS | `meanAbsDiff=0.300` `mismatchRatio=0.450%`
  - `texture_core`：PASS | `meanAbsDiff=0.280` `mismatchRatio=0.452%`
  - `combo_core`：PASS | `meanAbsDiff=0.249` `mismatchRatio=0.336%`
- 稳定性：`uncapturedErrors=0`，`deviceLost=NO`  
- 结论：`M4 Gate: PASS`

### 手工验证

- `wet edge` 连续绘制：白框消失，历史笔触不再异常变深。  
- `dual brush` + `opacity < 100%`：无矩形残留与异常叠深。

## 经验沉淀

1. **凡是“只写 dirty rect”的输出纹理，都必须有确定性初始化策略**。  
2. **清理必须发生在“可能重建纹理”的同步步骤之后**，否则清理对象可能失效。  
3. **自动化门禁与手测互补不可替代**：门禁能兜底一致性，手测更容易暴露实时交互伪影。  
4. **遇到白框/矩形伪影时，优先检查输出纹理生命周期**（usage、clear 覆盖范围、clear 时机），再看 blend 数学。

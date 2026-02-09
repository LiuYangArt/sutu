# ABR 导入参数漏映射复盘（2026-02-09）

## 背景

用户反馈 ABR 导入后，`Shape Dynamics -> Minimum Diameter` 与 Photoshop 不一致（常被显示为 `0%`）。
排查过程中进一步发现，主笔刷 `Scattering` 在部分 ABR 中也存在“应有值未导入”的情况。

本轮目标：

1. 修复 `Minimum Diameter` 导入缺失。
2. 系统检查同类参数漏导入并一并补齐。
3. 形成可复用的参数排查方法，避免后续重复踩坑。

## 现象

1. Photoshop 中 `Minimum Diameter` 为非 0（例如 `44%`），PaintBoard 导入后显示 `0%`。
2. 部分笔刷 `Scatter` 在 Photoshop 非 0，导入后为 `0`。
3. 同一 ABR 内大量笔刷存在类似模式，说明不是单笔刷脏数据，而是解析优先级问题。

## 根因

根因不是“字段不存在”，而是“字段优先级错误 + 占位值覆盖真实值”。

在大量 ABR（如 `liuyang_paintbrushes.abr`、`202002.abr`）中，字段分布是：

1. `minimumDiameter`、`minimumRoundness` 常写在 **root**。
2. `szVr.Mnm`、`roundnessDynamics.Mnm` 常是 `0` 占位。
3. `scatter` 常不写在 root 的 `Scat/Sctr`，而写在 `scatterDynamics.jitter`。

旧逻辑优先读子描述符 `Mnm`，导致：

1. 先读到 `0`，覆盖 root 的真实值。
2. root 未写 `Scat/Sctr` 时，`scatterDynamics.jitter` 未作为回退来源，最终导入 `0`。

## 修复方案

文件：`src-tauri/src/abr/parser.rs`

### 1) Shape Dynamics 最小值优先级修正

1. `minimumDiameter`：优先 root（含 `ShDy` 嵌套路径），无值再回退到 `szVr` 的 `Mnm/minimum`。
2. `minimumRoundness`：优先 root（含 `ShDy` 嵌套路径），无值再回退到 `roundnessDynamics` 的 `Mnm/minimum`。
3. 同步补齐 `ShDy` 嵌套结构下 `useTipDynamics/szVr/angleDynamics/roundnessDynamics` 读取。

### 2) Scatter 回退解析补齐

1. 优先读取 root `Scat/Sctr/scatter`。
2. 若 root 未给出有效值（`<= 0`），回退读取 `scatterDynamics.jitter`。

## 验证

### 自动化测试（新增/通过）

1. `test_shape_minimum_prefers_root_over_zero_in_dynamics_descriptor`
2. `test_scatter_uses_scatter_dynamics_jitter_when_root_scatter_missing`
3. `test_parse_liuyang_shape_minimum_and_scatter_fallback`

同时回归通过：

1. `test_apply_advanced_dynamics_from_descriptor`
2. `test_apply_brush_tip_params_hardness_keeps_percent_scale`

### 样本验证

使用 `liuyang_paintbrushes.abr` 做真实解析验证，确认：

1. `Sampled Brush 1 67` 导入后 `minimumDiameter = 44`。
2. `scribbles 2` 导入后 `scatter = 62`（来自 `scatterDynamics.jitter` 回退）。

## 经验沉淀

1. **ABR 描述符里“子结构字段”不一定是权威值**  
   `Mnm=0` 可能只是占位，不能天然高优先级。

2. **同一语义会跨层存储（root vs nested）**  
   解析必须先定义“语义优先级”，再定义“字段别名列表”。

3. **“有字段”不等于“有意义”**  
   对于已知占位模式，`0` 需要和“缺失”一起进入回退判断。

4. **必须用真实 ABR 做回归，而不是只靠构造数据**  
   单元测试覆盖语义，真实样本覆盖结构漂移。

## 后续建议

1. 建立“参数优先级矩阵”文档（root / nested / fallback / sentinel）。
2. 为关键参数增加一组跨 ABR 样本快照测试（最小值、scatter、transfer、color dynamics）。
3. 在 ABR 导入诊断日志中输出“参数来源路径”（例如 `minimumDiameter <- root`），加速后续排查。


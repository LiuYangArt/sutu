# Cursor Pipeline 中期优化计划（WinTab / scribbles 2）

## 1. 背景与证据链
- 已复现并确认：`scribbles 2` 在 WinTab 下小笔刷明显卡顿，PointerEvent 正常。
- 已验证：关闭/绕过复杂 brush cursor（改默认指针或简化显示）后，WinTab 卡顿显著缓解。
- 已确认：问题不在“是否采到点”，而在前端主线程中 cursor 路径处理与输入处理竞争，导致 WinTab 链路更易暴露高尾延迟。
- 已确认：同一链路下，不同 tip 的 `cursorPath` 复杂度差异可触发明显体感差异。

## 2. 目标指标
- 输入稳定性目标：WinTab 场景下 `emit -> frontend.recv` 高尾（P95/P99）持续下降，避免“后续整段画不出来”。
- 交互延迟目标：常见复杂 tip 下保持低抖动，避免 cursor 更新导致主线程阻塞。
- 体验一致性目标：PointerEvent / WinTab 在同笔刷下体感差距显著收敛。

## 3. 方案 A：Worker/OffscreenCanvas 预栅格化 cursor
### 思路
- 将 cursor SVG/path 解析、栅格化、编码等重活迁移到 Worker（支持 OffscreenCanvas 时优先使用）。
- 主线程只接收“已可用的 cursor 结果”（bitmap/dataURL/atlas 索引），负责快速应用。

### 收益
- 显著削弱主线程峰值开销，直接改善输入与渲染竞争。
- 对高复杂 tip 更稳健，减少 WinTab 场景高尾抖动。

### 风险与约束
- 浏览器能力差异（OffscreenCanvas、字体/路径行为一致性）需 fallback。
- 工程复杂度中高，需要补充 worker 生命周期与缓存同步策略。

## 4. 方案 B：导入阶段生成多级 cursor bitmap 缓存（size bucket）
### 思路
- 在 ABR/tip 导入或首次激活时，按 size bucket（如 16/24/32/48/64/96）预生成 cursor bitmap。
- 运行时按最近 bucket 直接命中，避免每次动态拼装 SVG 与编码。

### 收益
- 运行时 CPU 峰值低，行为可预测。
- 对复杂 tip 的最坏情况有上限，便于稳定 WinTab 体感。

### 风险与约束
- 启动/导入阶段会增加一次性成本与内存占用。
- bucket 策略需平衡清晰度与缓存体积。

## 5. 方案 C：运行时自适应策略（复杂 tip 自动切换与节流）
### 思路
- 基于 `cursorPath` 复杂度、最近帧预算、输入队列压力动态切换 cursor 模式（hardware/DOM/simplified）。
- 在压力高时对 cursor 更新做频率节流（例如每 N 帧更新）并确保绘制输入优先级更高。

### 收益
- 改造成本相对可控，可快速提升最坏场景稳定性。
- 与 A/B 兼容，可作为长期兜底层。

### 风险与约束
- 策略复杂后可解释性下降，需要更完整的 trace 字段支撑调试。
- 阈值不当可能导致视觉“跳档”。

## 6. 方案对比（收益 / 风险 / 工程量 / 跨平台）
- 方案 A
  - 收益：高
  - 风险：中
  - 工程量：高
  - 跨平台限制：中（能力检测与 fallback 必做）
- 方案 B
  - 收益：中高
  - 风险：中
  - 工程量：中
  - 跨平台限制：低到中（主要是缓存策略与资源管理）
- 方案 C
  - 收益：中
  - 风险：中
  - 工程量：中低
  - 跨平台限制：低（逻辑层策略为主）

## 7. 推荐路线与里程碑（M1/M2/M3）
### M1（近期，低风险稳态）
- 扩展当前策略为“可观测自适应”：保留阈值门控，增加运行时统计与告警日志。
- 引入最小节流策略（仅在高压时触发），默认不影响普通笔刷。
- 灰度开关：`cursorAdaptivePolicyV1`（可按用户或会话开启）。

### M2（中期，收益优先）
- 落地方案 B：导入/首次激活预生成多级 bitmap 缓存。
- 建立缓存预算与淘汰策略（按 tip 活跃度 + LRU）。
- 灰度开关：`cursorPreRasterCacheV1`，支持一键回退。

### M3（中长期，上限能力）
- 落地方案 A 的 worker 化主链路，主线程只做应用。
- 在不支持能力的平台自动回退到 M2/M1。
- 灰度开关：`cursorWorkerPipelineV1`，按平台与硬件分批放量。

### 回滚策略
- 所有阶段必须保留 feature flag；任一阶段可在运行时回退到“当前稳定策略”。
- 回滚优先级：A -> B -> C/阈值门控，确保线上可快速止损。

## 8. 观测与调试字段补充建议
- 在 trace 中补充以下字段：
  - `cursor_mode`：`hardware | dom | simplified | crosshair`
  - `cursor_tip_id`
  - `cursor_path_len`
  - `cursor_cache_hit`（bool）
  - `cursor_build_ms`
  - `cursor_apply_ms`
  - `cursor_queue_depth`
  - `cursor_policy_reason`（如 `path_too_long` / `pressure_high`）
- 在分析脚本中增加维度聚合：
  - 按 `cursor_mode` 统计 P50/P95/P99
  - 按 tip 分组比较 `emit->frontend.recv` 高尾与丢包指标
  - 对比 WinTab 与 PointerEvent 的差异收敛情况

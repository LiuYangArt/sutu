# MacNative 对齐 Krita 契约冻结附录（2026-02-20）

## 1. 冻结范围
1. `NativeTabletEventV3` 字段集合冻结，不增删字段。
2. `x_px/y_px` 语义冻结为 `WebView client` 像素域，左上原点。
3. `host_time_us` 在同 `stroke_id` 内必须单调递增。
4. `up` 必须显式发包，禁止隐式结束。

## 2. 相位优先级
1. 显式边沿优先：`MouseDown/MouseUp` 高于压力推导。
2. 接触状态次优先：`in_contact=true` 产生 `down/move`，`in_contact=false` 收敛 `up/hover`。
3. 压力仅作辅助，不得覆盖显式边沿。

## 3. 坐标域与时间基
1. Rust 端完成坐标统一，前端仅执行 `client px -> canvas px` 缩放映射。
2. 坐标越界一律记录 `coord_out_of_view_count`，允许继续发包但必须可观测。
3. `host_time_us`、`device_time_us` 均执行单调修正；修正计入对应计数。

## 4. 诊断计数口径
1. `phase_transition_error_count`：状态机非法边沿次数。
2. `host_time_non_monotonic_count`：`host_time_us` 被修正次数。
3. `stroke_tail_drop_count`：跨笔尾段/越序尾段被丢弃次数。
4. `native_down_without_seed_count`：消费链路出现“无 down 先到 move/up”次数。
5. `coord_out_of_view_count`：坐标落在视口外次数。
6. `seq_rewind_recovery_fail_count`：`seq` 回绕后首包恢复失败次数。
7. `pressure_clamp_count`：压力值被 clamp 次数。
8. `pressure_total_count`：压力样本总数。

## 5. 默认阈值（Blocking）
1. `native_empty_with_contact_rate <= 0.5%`
2. `pressure_clamp_rate <= 0.1%`
3. `first_dab_pressure_error_p95 <= 0.12`
4. `emit_to_frontend_recv_p95_ms <= 8`

## 6. 调整规则
1. 阈值仅允许通过更新本附录一次性调整。
2. 代码中禁止引入动态阈值分支或运行时 fallback。

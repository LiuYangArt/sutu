# MacNative 统一入口 Trace 复盘与 Wacom Driver 路线（2026-02-21）

## 1. 背景
1. 本次目标是只看新 trace，不继续功能迭代。
2. 分析命令：
   1. `node scripts/debug/analyze-tablet-pipeline-lag.mjs --tail 20000`
   2. `node scripts/debug/analyze-tablet-trace.mjs --tail 20000`
3. trace 文件：`~/Library/Application Support/com.sutu/debug/tablet-input-trace.ndjson`

## 2. 本次证据
1. 传输链路指标：
   1. `host->recv p50=3.61ms, p90=5.04ms, p99=12.96ms`
   2. `emit->frontend.recv p95=4.47ms`（阈值 `<=8ms`，通过）
2. 统一入口消费信号存在：
   1. `frontend.ingress.native_tick_consume=421`
   2. `frontend.canvas.consume_point=410`
   3. `frontend.canvas.dab_emit=435`
3. 门禁相关：
   1. `space_pan_draw_leak_count=0`（通过）
   2. `native_pump_primary_consume_rate=0`（通过）
4. 仍需关注的异常计数：
   1. `frontend.anomaly.native_down_without_seed=15`
   2. `frontend.anomaly.native_seq_rewind_recovery_fail=11`
   3. `frontend.anomaly.input_without_dabs=24`

## 3. 关键结论
1. 本次 trace 里，Rust 发射与 IPC 传输不是主要瓶颈，`emit->recv` 满足门禁。
2. 实际上已经出现大量统一入口消费与出 dab 事件，说明链路工作中。
3. 当前 `stroke summary` 里全部 `DROP_BEFORE_CONSUME` 与 top scope 明显冲突，原因是脚本统计口径还未把 `frontend.ingress.native_tick_consume` 计入 `native_consume` 的 stroke verdict；该结论属于“分析脚本口径偏差”，不是直接等价于“真实全丢笔”。
4. 真正需要继续盯的是 `down_without_seed / seq_rewind_recovery_fail / input_without_dabs` 三个异常族在具体动作中的触发条件。

## 4. 经验沉淀
1. 统一入口改造后，分析脚本必须同步更新“主消费 scope 列表”，否则会产生误判。
2. 只看 `stroke summary` 不够，必须和 `top scopes + canvas.consume_point + dab_emit` 交叉验证。
3. `pressure_clamp_rate` 和 `first_dab_pressure_error_p95` 仍会出现 `n/a`，当次 trace 中需要保证包含足够的 `frontend.status.snapshot` 与有效首点对齐样本。

## 5. 如果后续要接 Wacom Driver（macOS）怎么做
> 本节是后续路线，不在本轮实现范围。

1. 总体原则：
   1. 新后端只负责“采样与映射到 `NativeTabletEventV3`”，不得绕过 `UnifiedSessionRouterV3`。
   2. 保持前端入口统一，不新增第四套消费调度。
2. 建议路线（分阶段）：
   1. Phase A（可行性验证）：
      1. 在 Rust 侧新增 `wacom_driver_backend` 原型模块（独立 feature flag）。
      2. 只做采样频率与时间戳完整性采集，不接绘制主链。
      3. 验证 `host_time_us` 间隔分布是否稳定逼近 `5ms`（约 `200Hz`）。
   2. Phase B（协议归一）：
      1. 将驱动输出统一映射到 `NativeTabletEventV3` 固定字段。
      2. 保证 `x_px/y_px` 仍在 WebView client px 语义。
      3. 补齐 `phase_transition_error_count/host_time_non_monotonic_count` 诊断。
   3. Phase C（灰度接入）：
      1. 仅作为手动 backend 选项，不做自动 fallback。
      2. 与 `macnative/pointerevent` 用同一套 trace 与 blocking 指标对比。
3. 风险与门槛：
   1. 不同 Wacom 型号 HID report 差异大，解析成本高。
   2. macOS 权限/事件源限制需提前验证（尤其后台/前台焦点行为）。
   3. 若新后端未显著降低 `host_to_ingress_consume_p95` 或提升稳定性，不应切主。

## 6. 本轮决策
1. 按要求暂停继续功能改动，不基于本次 log 继续做行为修补。
2. 本轮只完成证据归档、经验沉淀、代码清理与提交。

# MacNative V3 Blocking 指标 + 手测记录模板

## 1. 基本信息
1. 记录日期：
2. 构建版本（`package.json`）：
3. 平台与设备（macOS 版本 / 数位板型号）：
4. backend：`macnative` / `pointerevent`（手动切换）：

## 2. 自动验证结果
1. `cargo check --manifest-path src-tauri/Cargo.toml --lib`
2. `pnpm check:all`
3. `pnpm test -- src/components/Canvas/__tests__/usePointerHandlers.nativeOffset.test.ts`
4. `pnpm test -- src/engine/kritaParityInput/__tests__/macnativePipelineV3.test.ts`
5. `pnpm test -- src/engine/kritaParityInput/__tests__/macnativeSeqRewindRecovery.test.ts`

## 3. Trace 采集
1. 是否开启 trace：是 / 否
2. 采样命令：`node scripts/debug/analyze-tablet-trace.mjs --tail 20000`
3. 延迟命令：`node scripts/debug/analyze-tablet-pipeline-lag.mjs --tail 20000`
4. trace 文件路径：

## 4. 12 个 Blocking 指标
1. `phase_transition_error_count`：
2. `host_time_non_monotonic_count`：
3. `stroke_tail_drop_count`：
4. `native_down_without_seed_count`：
5. `native_empty_with_contact_rate`（阈值 <= 0.5%）：
6. `coord_out_of_view_count`：
7. `pressure_clamp_rate`（阈值 <= 0.1%）：
8. `first_dab_pressure_error_p95`（阈值 <= 0.12）：
9. `first_3_points_phase_consistency_rate`（阈值 = 100%）：
10. `emit_to_frontend_recv_p95_ms`（阈值 <= 8）：
11. `native_pump_suppressed_by_hover_count`：
12. `seq_rewind_recovery_fail_count`：

## 5. 手测记录（每组 20 条）
1. 慢抬笔：通过 / 失败，说明：
2. 快甩笔：通过 / 失败，说明：
3. 低压轻拖：通过 / 失败，说明：
4. 点按-抬笔：通过 / 失败，说明：
5. 双屏 + Retina 缩放：通过 / 失败，说明：
6. 窗口移动后继续画：通过 / 失败，说明：

## 6. 失败条目（逐条）
1. 笔刷 preset：
2. 动作类型：
3. 失败截图/录屏时间点：
4. 输入源：
5. 指标快照：
6. 临时结论：

## 7. 结论
1. 是否满足切主门禁：是 / 否
2. 若否，阻塞项编号：
3. 后续动作（修复单 / 回归单）：

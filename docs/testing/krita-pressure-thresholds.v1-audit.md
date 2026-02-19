# Krita 压感阈值审计 v1

- 生成时间: 2026-02-18T11:17:08.025Z
- 运行次数: 30
- baseline: krita-5.2-default-wintab
- threshold_version: krita-pressure-thresholds.v1
- run_id: kp_threshold_audit_mlrxtgs9
- 输入 hash: 9d17bed1

## 结论

- 阈值检查结论: 通过
- 超限指标数: 0

## 指标对比（p99 vs 当前阈值）

| metric | p99 | threshold | margin | status |
| --- | ---: | ---: | ---: | --- |
| fast.fast_speed_mae | 0.000000 | 0.040000 | 0.040000 | pass |
| fast.fast_speed_p95 | 0.791216 | 1.000000 | 0.208784 | pass |
| fast.fast_window_min_required | 1.000000 | 1.000000 | 0.000000 | pass |
| final.pixel_roi_delta | 0.000000 | 0.120000 | 0.120000 | pass |
| final.tail_decay_delta | 0.000000 | 0.070000 | 0.070000 | pass |
| final.width_profile_delta | 0.000000 | 0.050000 | 0.050000 | pass |
| preset.combiner_output_mae | 0.000000 | 0.030000 | 0.030000 | pass |
| preset.combiner_output_p95 | 0.000000 | 0.060000 | 0.060000 | pass |
| preset.sensor_map_mae | 0.000000 | 0.020000 | 0.020000 | pass |
| preset.sensor_map_p95 | 0.000000 | 0.040000 | 0.040000 | pass |
| stage.carry_distance_error_px | 0.873990 | 1.500000 | 0.626010 | pass |
| stage.carry_time_error_ms | 0.200000 | 2.000000 | 1.800000 | pass |
| stage.combiner_output_mae | 0.000000 | 0.030000 | 0.030000 | pass |
| stage.combiner_output_p95 | 0.000000 | 0.060000 | 0.060000 | pass |
| stage.dab_count_delta | 0.000000 | 2.000000 | 2.000000 | pass |
| stage.pressure_curve_mae | 0.000000 | 0.020000 | 0.020000 | pass |
| stage.pressure_curve_p95 | 0.000000 | 0.040000 | 0.040000 | pass |
| stage.pressure_mix_mae | 0.000000 | 0.020000 | 0.020000 | pass |
| stage.sensor_value_mae | 0.000000 | 0.020000 | 0.020000 | pass |
| stage.sensor_value_p95 | 0.000000 | 0.040000 | 0.040000 | pass |
| stage.speed_mae | 0.000000 | 0.030000 | 0.030000 | pass |
| stage.speed_mix_mae | 0.000000 | 0.030000 | 0.030000 | pass |
| stage.speed_p95 | 0.000000 | 0.060000 | 0.060000 | pass |
| stage.time_mix_mae_us | 0.000000 | 1500.000000 | 1500.000000 | pass |

## 审计说明

- 口径: 同一 baseline/capture 进行多轮 gate，统计数值指标 p99。
- 判定: 仅当所有指标 p99 <= 当前阈值时通过。
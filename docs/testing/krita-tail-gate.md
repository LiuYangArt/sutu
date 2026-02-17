# Krita Tail Gate（多后端，Strict 默认）

## 目标
以 `krita-tail-trace-v2` 对齐 Sutu 与 Krita 的压感链路（head/body/tail + 语义检查），并按输入后端执行 strict gate。

## 前置条件
1. 本地前端服务可访问：`http://localhost:1420/`
2. fixtures 存在：`tests/fixtures/krita-tail/`
3. 页面已暴露调试 API：
   - `window.__kritaTailTraceStart`
   - `window.__kritaTailTraceStop`
   - `window.__kritaTailTraceLast`
   - `window.__strokeCaptureReplay`

## 运行 Gate（全后端）
```bash
pnpm -s run gate:krita-tail -- --url http://localhost:1420/
```

## 运行 Gate（单后端）
```bash
pnpm -s run gate:krita-tail -- --url http://localhost:1420/ --backend windows_wintab
pnpm -s run gate:krita-tail -- --url http://localhost:1420/ --backend windows_winink_pointer
pnpm -s run gate:krita-tail -- --url http://localhost:1420/ --backend mac_native
```

可选参数：
- `--case "slow_lift,fast_flick"`
- `--output debug_output/krita-tail-gate/manual-run`
- `--fixtures tests/fixtures/krita-tail`
- `--threshold-profile strict|calibrated|legacy`（默认 `strict`）
- `--thresholds tests/fixtures/krita-tail/thresholds.strict.json`

## 运行阈值校准（默认 10 轮）
```bash
pnpm -s run gate:krita-tail:calibrate -- --url http://localhost:1420/ --rounds 10
```

单后端校准：
```bash
pnpm -s run gate:krita-tail:calibrate -- --url http://localhost:1420/ --backend windows_wintab --rounds 10
```

可选参数：
- `--case "slow_lift,low_pressure_drag"`
- `--out-thresholds thresholds.calibrated.json`
- `--output debug_output/krita-tail-gate/calibrate-manual`

## 人工验收步骤
1. 分别执行三个后端的单后端 gate 命令。
2. 打开 `debug_output/.../summary.json`，确认 `backendOrder` 与 `backends[]` 中有 3 个后端条目。
3. 验收口径：
   - 三后端全部按 `blocking` 判定。
   - `semanticChecks` 任一失败直接 FAIL，不进入数值阈值判定。
   - `terminal_sample_drop_count` 必须为 0。
4. 分别执行三个后端的单后端校准 10 轮命令，确认输出 `thresholds.calibrated.json` 为 `krita-tail-thresholds-v2` 且 `backends` 分组完整。

## 输出结构
每个后端下每个 case 输出六件套：
1. `trace.sutu.json`
2. `trace.krita.json`
3. `report.json`
4. `stage_diff.csv`
5. `tail_chart.png`
6. `summary.json`（位于 run 根目录，按 backend 汇总）

## 默认地址约束
所有命令示例和脚本默认 URL 固定使用：`http://localhost:1420/`。

## 阈值文件约定
1. `tests/fixtures/krita-tail/thresholds.strict.json`：默认验收阈值（人工审计版）。
2. `tests/fixtures/krita-tail/thresholds.calibrated.json`：校准脚本输出（只用于参考/对比）。
3. `tests/fixtures/krita-tail/thresholds.json`：legacy 兼容阈值（仅通过 `--threshold-profile legacy` 使用）。

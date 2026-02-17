# Krita Tail Gate（多后端）

## 目标
以 `krita-tail-trace-v1` 对齐 Sutu 与 Krita 的尾段压感，并按输入后端独立 gate。

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
- `--thresholds tests/fixtures/krita-tail/thresholds.json`

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
- `--out-thresholds thresholds.json`
- `--output debug_output/krita-tail-gate/calibrate-manual`

## 人工验收步骤
1. 分别执行三个后端的单后端 gate 命令。
2. 打开 `debug_output/.../summary.json`，确认 `backendOrder` 与 `backends[]` 中有 3 个后端条目。
3. 验收口径：
   - `windows_wintab`：blocking 指标必须全部通过。
   - `windows_winink_pointer` / `mac_native`：允许出现 warning，但 `terminal_sample_drop_count` 必须为 0，否则按失败处理。
4. 分别执行三个后端的单后端校准 10 轮命令，确认输出 `thresholds.json` 为 `krita-tail-thresholds-v2` 且 `backends` 分组完整。

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

# Krita Tail Gate（Phase0）

## 目标
以 `krita-tail-trace-v1` 对齐 Sutu 与 Krita 在尾段压感表现。

## 前置条件
1. 本地前端服务可访问：`http://localhost:1420/`
2. fixtures 存在：`tests/fixtures/krita-tail/`
3. 页面已暴露调试 API：
   - `window.__kritaTailTraceStart`
   - `window.__kritaTailTraceStop`
   - `window.__kritaTailTraceLast`
   - `window.__strokeCaptureReplay`

## 运行 gate
```bash
pnpm -s run gate:krita-tail -- --url http://localhost:1420/
```

可选参数：
- `--case "slow_lift,fast_flick"`
- `--output debug_output/krita-tail-gate/manual-run`
- `--fixtures tests/fixtures/krita-tail`
- `--thresholds tests/fixtures/krita-tail/thresholds.json`

## 运行阈值校准
```bash
pnpm -s run gate:krita-tail:calibrate -- --url http://localhost:1420/ --rounds 10
```

可选参数：
- `--case "slow_lift,low_pressure_drag"`
- `--out-thresholds thresholds.json`
- `--output debug_output/krita-tail-gate/calibrate-manual`

## 输出结构
每个 case 输出六件套：
1. `trace.sutu.json`
2. `trace.krita.json`
3. `report.json`
4. `stage_diff.csv`
5. `tail_chart.png`
6. `summary.json`（位于 run 根目录）

## 默认地址约束
所有命令示例和脚本默认 URL 固定使用：`http://localhost:1420/`。

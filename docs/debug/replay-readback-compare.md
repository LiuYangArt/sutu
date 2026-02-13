# 回放 A/B 对比脚本（Readback Enabled vs Disabled）

用于定位 GPU `Subtract` 的 dab 感是否来自 `No-Readback` 路径。
注意：这个脚本只比较 `readback enabled/disabled`，不比较 `CPU/GPU`。
脚本会在同一份笔触 capture 上跑两次回放：

1. `readback mode = enabled`
2. `readback mode = disabled`

然后导出两张图和一张差异图，并输出数值指标（`meanAbsDiff / maxDiff / mismatchRatio`）。

## 前置条件

1. 已启动可访问的前端页面（建议显式用 `http://localhost:1420`）。
2. 页面已挂载调试 API（`window.__strokeCaptureReplay`、`window.__getFlattenedImage` 等）。
3. 当前运行时需要可切换 readback mode（`window.__gpuBrushCommitReadbackModeSet` 可用）。
4. 有可用 capture：
   - 优先：通过 `--capture` 指定 json 文件。
   - 默认路径：`%APPDATA%/com.paintboard/debug-data/debug-stroke-capture.json`。
   - 如果你本机是 `com.sutu` 包名，请显式传 `--capture`。

## 命令

```bash
node scripts/debug/replay-readback-compare.mjs --url http://localhost:1420 --capture "C:/Users/<you>/AppData/Roaming/com.sutu/debug-data/debug-stroke-capture.json" --output debug_output/replay_readback_compare --label subtract-case --speed 1 --wait-ms 300
```

## 输出

脚本会在输出目录生成：

1. `*-enabled.png`
2. `*-disabled.png`
3. `*-diff.png`
4. `*-report.json`

`report.json` 包含关键指标：

- `meanAbsDiff`: 每通道平均绝对差
- `maxDiff`: 最大通道差
- `mismatchRatio`: 差异像素占比（阈值 4）

## 排查建议

1. 如果 `enabled` 与 `disabled` 差异明显（尤其 `mismatchRatio` 高），优先查 `No-Readback` 显示/提交链路。
2. 如果两者几乎一致，但都和 CPU 不同，优先查 compute 公式/掩码/采样一致性。
3. 如果报错 `Readback mode API unavailable in this runtime`，说明当前会话未暴露 readback mode 切换能力，需先确认 Debug Panel 的相关开关和运行模式。

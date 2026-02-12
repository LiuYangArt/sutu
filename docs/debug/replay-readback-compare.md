# 回放 A/B 对比脚本（Readback Enabled vs Disabled）

用于定位 GPU `Subtract` 的 dab 感是否来自 `No-Readback` 路径。  
脚本会在同一份笔触 capture 上跑两次回放：

1. `readback mode = enabled`
2. `readback mode = disabled`

然后导出两张图和一张差异图，并输出数值指标（`meanAbsDiff / maxDiff / mismatchRatio`）。

## 前置条件

1. 已启动可访问的前端页面（默认 `http://127.0.0.1:1420`）。
2. 页面已挂载调试 API（`window.__strokeCaptureReplay`、`window.__getFlattenedImage` 等）。
3. 有可用 capture：
   - 优先：通过 `--capture` 指定 json 文件。
   - 否则：默认读取 `%APPDATA%/com.paintboard/debug-data/debug-stroke-capture.json`。

## 命令

```bash
node scripts/debug/replay-readback-compare.mjs \
  --url http://127.0.0.1:1420 \
  --capture "C:/Users/<you>/AppData/Roaming/com.paintboard/debug-data/debug-stroke-capture.json" \
  --output debug_output/replay_readback_compare \
  --label subtract-case \
  --speed 1 \
  --wait-ms 300
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

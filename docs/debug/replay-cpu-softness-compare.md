# CPU Softness A/B 回放对比脚本

> 更新（2026-02-13）：运行时 Softness 已统一为 `gaussian`，UI 不再提供模式切换。

用于同一份笔触 capture 的 `CPU` 模式下 A/B 对比，快速观察：

1. 同一笔触在固定 `gaussian` 软边下，不同 `hardness / spacing / roundness / angle` 的变化。
2. 调整 `hardness / spacing / roundness / angle` 后的输出变化。
3. 修改笔刷曲线后的回归情况（截图 + diff + 指标）。

脚本会固定在 CPU 渲染模式回放两次，输出：

1. `A 图`
2. `B 图`
3. `diff 图`
4. `report.json`

## 脚本位置

`scripts/debug/replay-cpu-softness-compare.mjs`

## 前置条件

1. 本地页面可访问（默认 `http://localhost:1420`）。
2. 页面已挂载调试 API：
   - `window.__strokeCaptureReplay`
   - `window.__canvasClearLayer`
   - `window.__getFlattenedImage`
3. capture 文件可用（优先 `com.paintboard`，回退 `com.sutu`）。

## 快速使用

```bash
node scripts/debug/replay-cpu-softness-compare.mjs --url http://localhost:1420 --capture "C:/Users/<you>/AppData/Roaming/com.paintboard/debug-data/debug-stroke-capture.json" --hardness 50 --output "debug_output/brush_softness_compare" --label "h50-gaussian-baseline"
```

## 常用参数

- `--hardness`：覆盖 hardness（0~100），默认不覆盖（沿用 capture）
- `--spacing`：覆盖 spacing（0~1）
- `--roundness`：覆盖 roundness（0~100）
- `--angle`：覆盖 angle（度）
- `--seed`：固定随机种子，默认 `20260213`
- `--wait-ms`：回放后等待毫秒，默认 `300`
- `--headless`：`true/false`，默认 `false`

## 输出与判读

`report.json` 包含：

- `diff.meanAbsDiff / maxDiff / mismatchRatio`
- A/B 各自的基础分析：
  - `coveragePixels`
  - `softBandRatio`
  - `meanAlpha`
  - `meanEdgeGradient`

建议固定同一份 capture + 同一 seed，连续比较不同改动，避免把随机扰动误判成曲线差异。

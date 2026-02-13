# CPU/GPU Subtract 回放对比脚本

用于同一份笔触 capture 的 `CPU vs GPU` 直接对比，专门排查 `Texture Subtract` 一致性问题。

脚本会：

1. 强制注入纹理 pattern（默认 `pat5_sparthtex01.png`）。
2. 强制覆盖 capture 的 texture 设置（默认 `mode=subtract, depth=100, invert=true`）。
3. 同种子分别回放 `gpu` 和 `cpu`，导出 `cpu/gpu/diff/report`。
4. 在 GPU 模式先做一次预热回放，再清层跑正式回放，规避“首笔丢失”。

## 脚本位置

`scripts/debug/replay-cpu-gpu-subtract-compare.mjs`

## 前置条件

1. 本地页面可访问（默认 `http://localhost:1420`）。
2. 页面已挂载调试 API：
   - `window.__strokeCaptureReplay`
   - `window.__canvasClearLayer`
   - `window.__getFlattenedImage`
3. capture 文件可用（默认 `%APPDATA%/com.sutu/debug-data/debug-stroke-capture.json`）。
4. 纹理图在仓库内（默认 `debug_output/pat_decoded/pat5_sparthtex01.png`）。

## 快速使用

```bash
node scripts/debug/replay-cpu-gpu-subtract-compare.mjs --url http://localhost:1420 --capture "C:/Users/<you>/AppData/Roaming/com.sutu/debug-data/debug-stroke-capture.json" --texture "debug_output/pat_decoded/pat5_sparthtex01.png" --mode subtract --seed 424242 --output "debug_output/texture_formula_compare/cpu_gpu_subtract_compare" --label "subtract-cpu-gpu-seeded-warm"
```

## 输出

每次运行会生成 4 个文件：

1. `*-cpu.png`
2. `*-gpu.png`
3. `*-diff.png`
4. `*-report.json`

`report.json` 关键指标：

- `meanAbsDiff`
- `maxDiff`
- `mismatchRatio`

## 常用参数

- `--mode`：纹理混合模式（默认 `subtract`）
- `--depth`：0~100，默认 `100`
- `--scale`：纹理缩放，默认 `100`
- `--brightness`：默认 `0`
- `--contrast`：默认 `0`
- `--invert`：`true/false`，默认 `true`
- `--seed`：回放随机种子，默认 `424242`
- `--wait-ms`：回放后等待毫秒，默认 `300`
- `--headless`：`true/false`，默认 `false`

## 判读建议

1. 先看 `gpu.png` 是否明显有“第一笔缺失”或“首段断裂”。
2. 再看 `diff.png` 是否集中在首段；如果是，优先怀疑 GPU 首轮未稳定，不先改公式。
3. 确认 `report.json` 的 `patchedTextureSettings` 真的是本次目标模式（避免误测成默认笔刷）。
4. 对比不同模式时，固定同一 `seed` 和同一 capture，避免把随机扰动误判为公式差异。

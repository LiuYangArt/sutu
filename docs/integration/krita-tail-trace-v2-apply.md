# Krita Tail Trace v2 接入说明（不改 Krita 仓库文件）

## 你当前的限制
你要求“禁止改动 Krita 仓库文件”，因此本流程只做一件事：  
把**已经导出的** Krita v2 trace 接入到 PaintBoard，并完成 gate 验证。  

这意味着：如果目前还没有 v2 导出文件，本仓无法凭空生成它们。

## 目标
接入 `krita-tail-trace-v2` 基线文件后，使用 strict gate 验证 Sutu 与 Krita 链路一致性。  

## 需要准备的 4 个文件
每个 case 一个 `trace.krita.json`：

1. `tests/fixtures/krita-tail/krita-baseline/slow_lift/trace.krita.json`
2. `tests/fixtures/krita-tail/krita-baseline/fast_flick/trace.krita.json`
3. `tests/fixtures/krita-tail/krita-baseline/abrupt_stop/trace.krita.json`
4. `tests/fixtures/krita-tail/krita-baseline/low_pressure_drag/trace.krita.json`

## 文件内容必须满足
1. `schemaVersion` 必须是 `krita-tail-trace-v2`。
2. `stages.dab_emit[].sizePx` 必须存在且为正数。
3. `meta.runtimeFlags` 必须包含：
   - `legacyStartDistanceGateEnabled`
   - `legacyStartTransitionRampEnabled`
   - `legacyForceZeroInitialPressureEnabled`
   - `dynamicSpacingTimingUpdateEnabled`
4. 保留完整 stage：`input_raw`、`pressure_mapped`、`sampler_t`、`dab_emit`。

## 接入后验证
1. 启动前端（确保 `http://localhost:1420/` 可访问）。
2. 运行：
   ```bash
   pnpm -s run gate:krita-tail -- --url http://localhost:1420/ --threshold-profile strict
   ```
3. 查看最新 `debug_output/krita-tail-gate/*/summary.json`：
   - 语义项先看 `semanticFailures`
   - 数值项看 `numericFailures`
   - 三后端都必须 `mode=blocking`

## 已改本地 Krita 后，如何拿到 4 个真实文件（一步一步）
前提：你已经使用本地修改后的 Krita 可执行程序。

1. 启动 Krita 前，在终端设置环境变量（PowerShell）：
   ```powershell
   $env:KRITA_TAIL_TRACE_OUTPUT="F:\CodeProjects\PaintBoard\tests\fixtures\krita-tail\krita-baseline\slow_lift\trace.krita.json"
   $env:KRITA_TAIL_TRACE_CASE_ID="slow_lift"
   $env:KRITA_TAIL_TRACE_INPUT_BACKEND="windows_wintab"
   ```
2. 用这个终端启动 Krita，并在 Krita 中按 `slow_lift.capture.json` 对应手法画一笔（一次笔划）。
3. 关闭笔划后，检查目标文件是否更新：
   - `tests/fixtures/krita-tail/krita-baseline/slow_lift/trace.krita.json`
4. 依次重复 `fast_flick`、`abrupt_stop`、`low_pressure_drag`，只改：
   - `KRITA_TAIL_TRACE_OUTPUT`
   - `KRITA_TAIL_TRACE_CASE_ID`
5. 四个文件都有后，运行 strict gate：
   ```bash
   pnpm -s run gate:krita-tail -- --url http://localhost:1420/ --threshold-profile strict
   ```

说明：
1. 导出由 Krita 运行时自动写入，不需要手写 JSON。
2. 若你不设 `KRITA_TAIL_TRACE_OUTPUT`，默认写到 Krita 的 AppData 目录下 `krita-tail-trace/trace.krita.json`。

## 关于你本机真实录制文件
`C:\Users\LiuYang\AppData\Roaming\com.sutu\debug-data\debug-stroke-capture.json`  
是实际录制产物，不是当前 4 个固定 case 的来源文件。  

当前这份文件包含多段笔划（不是单 case），可用于“真实手感回放回归”，但不能直接替代 strict Krita 对比基线。  
原因是 strict 对比必须是“同一输入 case 的 Krita trace vs Sutu trace”一一配对。

## 推荐执行方式（并行）
1. 保留当前 4 个固定 case 跑 strict gate（稳定、可回归）。
2. 额外用你的真实 capture 做补充回放验证（更贴近实战手感）。
3. 若后续要把真实 capture 纳入 strict gate，需要先拿到该 capture 对应的 Krita v2 trace，再做一一配对。

## 临时方案（仅用于流程联调，不用于最终验收）
当你手头只有 Krita v1 基线文件时，可先在本仓生成“synthetic v2”：

```bash
node scripts/debug/upgrade-krita-tail-baseline-v1-to-v2.mjs \
  --fixtures tests/fixtures/krita-tail \
  --config baseline-config.json \
  --out-baseline-dir krita-baseline-v2-synthetic \
  --out-config baseline-config.synthetic-v2.json
```

然后用该 config 跑 gate：

```bash
pnpm -s run gate:krita-tail -- --url http://localhost:1420/ \
  --threshold-profile strict \
  --config tests/fixtures/krita-tail/baseline-config.synthetic-v2.json
```

注意：
1. 该方案会按 capture 的 `brushSize * pressure` 估算 `sizePx`。
2. 这只能用于验证 v2 管线是否跑通，不能当作“与 Krita 严格一致”的最终证据。

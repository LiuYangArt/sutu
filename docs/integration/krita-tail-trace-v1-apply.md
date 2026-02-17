# Krita Tail Trace v1 Patch 使用说明

## 目标
将 Krita 端导出能力对齐到 `krita-tail-trace-v1`：
- `stages.pressure_mapped`
- `stages.sampler_t`
- `stages.dab_emit`

## 文件
- 补丁：`docs/integration/krita-tail-trace-v1.patch`
- 输出 trace 命名建议：`trace.krita.json`

## 应用步骤
1. 在 Krita 仓库根目录执行：
   ```bash
   git apply <sutu-repo>/docs/integration/krita-tail-trace-v1.patch
   ```
2. 若存在上下文漂移，使用 `git apply --reject`，按 `.rej` 手动合并。
3. 确认锚点文件已插入导出调用：
   - `libs/ui/tool/kis_painting_information_builder.cpp`
   - `libs/image/brushengine/kis_paintop_utils.h`
   - `libs/image/kis_distance_information.cpp`
4. 重新编译 Krita 并运行同一组 case，导出 `trace.krita.json`。

## 导出约束
1. `schemaVersion` 必须为 `krita-tail-trace-v1`。
2. `input_raw/pressure_mapped` 使用 `seq` 对齐。
3. `sampler_t` 需导出 `triggerKind + carryBefore/After`。
4. `dab_emit.source` 统一使用：`normal|finalize|pointerup_fallback`。

## 与 Sutu gate 对接
1. 将每个 case 的 Krita trace 放置到：
   - `tests/fixtures/krita-tail/krita-baseline/<caseId>/trace.krita.json`
2. 运行 gate：
   ```bash
   pnpm -s run gate:krita-tail -- --url http://localhost:1420/
   ```

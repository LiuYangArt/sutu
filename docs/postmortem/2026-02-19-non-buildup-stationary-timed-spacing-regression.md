# Postmortem: 非 Build-up 原地持续出墨与慢速不均匀（2026-02-19）

## 背景
我们在对齐 Krita 压感/采样链路重构后，主链路统一切到了 `KritaPressurePipeline`。  
用户反馈：`buildup` 关闭时，原地停笔仍会持续出墨，慢速拖动的笔触也会出现局部堆墨与不均匀。

## 现象
1. `buildup=false` 时，原地停笔 1~2 秒，笔迹仍继续加深。
2. 慢速移动时，dab 密度受时间采样影响，出现局部“串珠/结点”。
3. `wintab` 与 `pointerevent` 都能复现，`wintab` 更明显（采样更密，时间分支更容易触发）。

## 根因分析
### 1) 主链路把 timed spacing 当成默认行为
- `useBrushRenderer` 固定给 pipeline 传 `max_interval_us=16ms`，且未区分 `buildup`。
- `segmentSampler` 在 `distance=0` 但 `duration>0` 时，仍会按 time 分支产样本。
- 结果是：非 Build-up 也出现“类似 airbrush 的原地持续出墨”。

### 2) 语义偏差来自“开关位置”而不是输入噪声
- 输入层（WinTab/PointerEvent）只是放大了问题，不是根因。
- 真正偏差是“是否允许 timed spacing”没有被绑定到 Build-up 语义。

## 与 Krita 的差异与对齐结论
Krita 的 `paintLine` 支持 distance/time 双采样，但 timed spacing 并不是默认常开：  
默认笔刷主要按 distance spacing；airbrush 场景才启用 timed spacing。  
因此，本问题应通过“语义开关对齐”修复，而不是输入层去抖补丁。

## 修复方案
1. 在 `KritaPressurePipelineConfig` 新增 `timed_spacing_enabled`。
2. `segmentSampler` 仅在 `timed_spacing_enabled=true` 时执行 time 分支并维护 time carry。
3. `useBrushRenderer` 按 `buildupEnabled` 下发 timed 开关：
   - `buildup=false` -> timed 关闭（不再原地持续出墨）
   - `buildup=true` -> timed 开启（保留积累语义）
4. primary/secondary 双 pipeline 使用同一开关策略，防止 dual brush 语义分叉。

## 验证结果
1. 新增测试：`pipeline/dual secondary` 均覆盖“timed disabled 下 stationary move 不出 dab”。
2. 新增测试：`useBrushRendererOpacity` 覆盖 `buildup=false` stationary 不出 dab。
3. 回归测试通过：
   - `pipeline.test.ts`
   - `dualBrushSecondaryPipeline.test.ts`
   - `useBrushRendererOpacity.test.ts`
   - `useBrushRenderer.strokeEnd.test.ts`
4. `pnpm check:all` 通过（仓库既有 lint warning 不影响本次结论）。

## 教训与可复用经验
1. **重构时优先迁移“开关语义”，再迁移算法实现。**  
   采样算法对齐但开关位置错，会产生“看似正确、体感错误”的回归。
2. **不要把 timed sampling 当成通用默认。**  
   它属于 airbrush/build-up 语义，不应污染默认笔刷路径。
3. **双 pipeline（primary/secondary）必须共享关键行为开关。**  
   否则主副笔刷会出现难排查的手感偏差。

## 后续防回归
1. 保留并扩展 stationary 场景测试（`buildup on/off` 两组必须同时存在）。
2. 在采样层新增契约说明：timed spacing 的业务语义绑定到 build-up/airbrush。
3. 后续若引入独立 Airbrush 开关，应直接映射到 `timed_spacing_enabled`，避免分叉逻辑。

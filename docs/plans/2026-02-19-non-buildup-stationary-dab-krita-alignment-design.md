# 非 Build-up 原地持续出墨修复设计（对齐 Krita）

**日期**：2026-02-19  
**状态**：Draft（待评审）  
**范围**：仅修复“`buildup=false` 仍原地持续出墨/慢速不均匀”问题，不改其它笔刷特性

## 0. 直接结论（含置信度）

1. 当前问题首先是实现语义问题，不是输入后端单点异常。  
2. 根因是主链路把“按时间触发 dab”常开了：即使 `distance=0`，只要 `duration>0` 也会继续产 dab。  
3. `wintab` 比 `pointerevent` 更明显，符合“高采样频率更容易触发时间采样”的现象。  
4. Krita 的默认语义是：仅在 Airbrush（时间采样）开启时才允许按时间出 dab；非 Airbrush 主要按距离 spacing。  
5. 可直接对齐 Krita：将 timed spacing 开关与 `buildup` 绑定，`buildup=false` 时禁用 timed spacing。  

**计划置信度**：0.92

## 1. 现象与问题定义

### 1.1 用户可见症状

1. `buildup` 关闭时，笔停在原地仍会持续变黑。  
2. 慢速拖动时笔触密度不均，出现局部串珠/堆墨。  
3. WinTab 与 PointerEvent 均可复现，WinTab 更明显。  

### 1.2 与目标行为差异

1. Photoshop/Krita（非 Airbrush/非 Build-up）预期：原地不应持续喷涂。  
2. 当前 Sutu 行为：非 Build-up 也存在时间驱动的持续出墨。  

## 2. 根因证据（代码与参考实现）

### 2.1 Sutu 当前链路证据

1. Pipeline 配置固定 `max_interval_us=16ms`（约 62.5Hz），且未与 `buildupEnabled` 绑定：  
   `src/components/Canvas/useBrushRenderer.ts:184`  
   `src/components/Canvas/useBrushRenderer.ts:197`  
   `src/components/Canvas/useBrushRenderer.ts:272`
2. `segmentSampler` 同时做 distance + time 采样；`durationUs>0` 时会走 time 分支：  
   `src/engine/kritaParityInput/core/segmentSampler.ts:42`  
   `src/engine/kritaParityInput/core/segmentSampler.ts:71`
3. 当前测试已经把“零位移按 max interval 出 dab”写成预期：  
   `src/engine/kritaParityInput/__tests__/dualBrushSecondaryPipeline.test.ts:51`
4. 输入队列不会过滤同坐标 move，时间累积样本会持续进入 pipeline：  
   `src/components/Canvas/useRawPointerInput.ts:126`  
   `src/components/Canvas/usePointerHandlers.ts:565`  
   `src/components/Canvas/usePointerHandlers.ts:631`

### 2.2 Krita 对照证据

1. `paintLine` 里确实支持距离/时间双采样，但 timing 是可开关的：  
   `F:\CodeProjects\krita\libs\image\brushengine\kis_paintop_utils.h:67`  
   `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:420`
2. `KisDistanceInformation` 在 `start==end` 时距离分支直接返回不出点（需依赖 timed spacing 才会原地出点）：  
   `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:466`
3. 默认 paintop 的 `updateTimingImpl` 返回禁用 timing；只有 airbrush 相关选项开启才启用：  
   `F:\CodeProjects\krita\libs\image\brushengine\kis_paintop.cc:183`  
   `F:\CodeProjects\krita\plugins\paintops\libpaintop\kis_paintop_plugin_utils.h:90`

## 3. 目标与非目标

### 3.1 目标

1. `buildup=false`：原地停笔不再持续出墨。  
2. 慢速笔触密度更均匀，消除时间采样导致的局部堆墨。  
3. 对齐 Krita 默认语义：timed spacing 仅在 airbrush-like 语义开启时生效。  
4. primary/secondary（dual brush）语义保持一致。  

### 3.2 非目标

1. 不在本次重做 transfer/wet edge/texture 混合公式。  
2. 不引入新的笔刷 UI 面板（先复用现有 `buildup`）。  
3. 不在本次处理 iPad 端适配。  

## 4. 方案对比（含效果/用途）

### 方案 A（推荐）：Krita 语义直连

思路：

1. 给 pipeline 增加显式 `timed_spacing_enabled`。  
2. `buildup=false` 时关闭 timed spacing；`buildup=true` 时开启 timed spacing。  
3. timed interval 不再全局固定 16ms，而是由 build-up 速率语义控制（与现有 build-up tick 口径一致）。  

效果/用途：

1. 非 buildup 路径回到纯 distance spacing，直接消除原地持续出墨。  
2. buildup 路径保留时间积累能力，行为可解释且可调。  
3. 与 Krita“默认关闭 timed、airbrush 开启 timed”的语义一致。  

优点：

1. 根因修复，语义清晰。  
2. 对 primary/secondary 可统一。  
3. 回归范围可控（采样层）。  

缺点：

1. 需要调整现有测试预期（当前把零位移时间出点当成默认预期）。  

### 方案 B：全局关闭 timed spacing（仅靠现有路径）

思路：

1. 直接移除 time 采样分支（或永久禁用）。  

效果/用途：

1. 快速止血非 buildup 的原地出墨问题。  

缺点：

1. build-up 的时间积累语义会被削弱或失真。  
2. 与 Krita 的 airbrush 语义不完全一致。  

### 方案 C：仅在输入层做零位移过滤

思路：

1. 对同坐标输入点做去重/限频。  

效果/用途：

1. 可降低局部重复输入噪声。  

缺点：

1. 不是根因修复；慢速不均匀仍可能存在。  
2. 容易误伤压感/倾斜等有效变化。  

**结论**：采用方案 A。

## 5. 变更后目标架构

1. 输入层继续产出 `RawInputSample`（不改后端采样协议）。  
2. Pipeline 采样层改为：  
   - Distance sampling：始终开启。  
   - Timed sampling：仅当 `timed_spacing_enabled=true`（由 `buildup` 驱动）时开启。  
3. `useStrokeProcessor` 的 build-up tick 继续作为“静止时推进时间”的机制。  
4. primary 与 secondary pipeline 使用同一 timed 开关策略，避免双笔刷语义分裂。  

## 6. 拟改文件清单（实施时）

1. `src/engine/kritaParityInput/core/segmentSampler.ts`  
   - 新增 timed 开关分支，关闭时跳过 time sample 生成。  
2. `src/engine/kritaParityInput/pipeline/kritaPressurePipeline.ts`  
   - 扩展 config：`timed_spacing_enabled`（默认 `false`）。  
3. `src/engine/kritaParityInput/pipeline/dualBrushSecondaryPipeline.ts`  
   - 透传 timed 开关策略，与主笔一致。  
4. `src/components/Canvas/useBrushRenderer.ts`  
   - 不再固定 `16ms` 作为全局 max interval。  
   - 根据 `buildupEnabled` 生成 pipeline timed 配置。  
5. 测试文件：  
   - `src/engine/kritaParityInput/__tests__/pipeline.test.ts`  
   - `src/engine/kritaParityInput/__tests__/dualBrushSecondaryPipeline.test.ts`  
   - `src/components/Canvas/__tests__/useBrushRendererOpacity.test.ts`（必要时补 stationary case）

## 7. Implementation Plan（中文）

### Phase 0：基线冻结与可观测性确认

1. 冻结复现参数：同一笔刷（size/spacing/flow/opacity）、同一画布、同一输入后端。  
2. 使用现有 trace 开关确认基线（无需先新增日志）：`window.__tabletInputTraceSet(true)`。  
3. 记录当前基线：non-buildup stationary 2s 的 dab 数、慢速线条均匀性截图。  

退出条件：

1. 有可重复 baseline（wintab + pointerevent 各一组）。  

### Phase 1：采样契约改造（核心）

1. 在 pipeline config 引入 `timed_spacing_enabled`。  
2. `segmentSampler` 在 `timed_spacing_enabled=false` 时不生成 time samples。  
3. 保持 distance carry 逻辑不变，避免引入新路径偏差。  

退出条件：

1. 单元测试可区分“timed on/off”两种语义。  

### Phase 2：主链路接线

1. `useBrushRenderer` 按 `buildupEnabled` 下发 timed 开关。  
2. primary/secondary 同步策略，避免 dual brush 行为漂移。  
3. 清理固定 `16ms` 常量在非 buildup 路径的语义耦合。  

退出条件：

1. `buildup=false` 路径不再触发 time sampling。  

### Phase 3：回归与验收

1. 自动化：pipeline + renderer 相关测试通过。  
2. 手测：  
   - non-buildup 原地 2s：不继续变黑。  
   - non-buildup 慢速拖线：密度均匀，无明显串珠。  
   - buildup 原地 2s：仍可持续积累。  
3. 后端一致性：wintab/pointerevent 均通过上述三项。  

退出条件：

1. 自动化全绿 + 手测矩阵通过。  

## 8. 验证与判定口径

### 8.1 自动化验证（实施后）

1. `pnpm -s vitest run src/engine/kritaParityInput/__tests__/pipeline.test.ts`  
2. `pnpm -s vitest run src/engine/kritaParityInput/__tests__/dualBrushSecondaryPipeline.test.ts`  
3. `pnpm -s vitest run src/components/Canvas/__tests__/useBrushRendererOpacity.test.ts`

### 8.2 手测步骤（实施后）

1. 切到 `pointerevent`，`buildup=false`，在画布同一点压笔停留 2 秒。  
   预期：不再持续加深。  
2. 切到 `wintab`，重复步骤 1。  
   预期：同样不持续加深。  
3. 两后端分别慢速画 5 条近直线。  
   预期：线条密度连续，无局部结珠。  
4. 打开 `buildup=true`，原地停留 2 秒。  
   预期：可观察到持续积累（airbrush-like）。  

### 8.3 Trace 判定（可选）

1. `window.__tabletInputTraceSet(true)` 后复现。  
2. 在 `buildup=false + stationary` 片段中，`frontend.canvas.dab_emit` 的 `dabs_count` 应趋近 0。  
3. `buildup=true + stationary` 片段中应看到受控 dab 输出。  

## 9. 风险与对策

1. 风险：build-up 手感变弱或过慢。  
   对策：把 timed interval 参数化并与 build-up rate 统一调参。  
2. 风险：dual brush 次笔刷密度变化。  
   对策：secondary 与 primary 使用同一 timed 开关，补专门回归。  
3. 风险：旧测试假设失效导致 CI 噪声。  
   对策：先改测试语义，再落实现，避免临时阈值放宽。  

## 10. Task List（中文）

1. [ ] 新增 pipeline timed 开关契约（`timed_spacing_enabled`）。  
2. [ ] `segmentSampler` 接入 timed 开关分支。  
3. [ ] `useBrushRenderer` 按 `buildupEnabled` 下发 timed 策略。  
4. [ ] primary/secondary pipeline 行为对齐。  
5. [ ] 更新/新增单测：non-buildup stationary 不出 dab。  
6. [ ] 执行自动化验证命令并存档结果。  
7. [ ] 执行 wintab + pointerevent 手测矩阵并存档截图/trace。  

## 11. Thought（中文）

1. 本问题本质是“语义开关位置错误”：把 airbrush 的时间采样放进了默认路径。  
2. 继续在输入层做去抖或过滤只会缓解，不会解决“非 buildup 仍按时间出墨”的根因。  
3. 直接对齐 Krita 的开关语义（timed only when airbrush/buildup）是风险最低、长期可维护性最高的路线。  

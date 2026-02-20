# WinTab / `scribbles 2` 卡顿与失效诊断（2026-02-20）

## 结论先行

在当前 trace（`2026-02-20T01:25:13Z` 到 `2026-02-20T01:25:25Z`）里，主异常边界更接近 **WinTab native 点在前端消费时序不稳定**，而不是单纯的画刷渲染崩溃：

1. `pointermove` 持续存在 pressure/contact，但频繁拿不到 native 点（`native_empty` + `native_missing_with_pointer`）。
2. 出现“长时间缺样 -> 突发批量消费”的时序。
3. 同时 `input_without_dabs` 很高，但这项在高 spacing 笔刷下有误报可能，不能单独作为根因。

另外，这份 trace 本身不包含笔刷 ID/名称字段，无法直接证明“当时是否为 `scribbles 2`”。  
此前用 `settings.json` 做了事后核对，但该文件写入时间晚于 trace 结束时间，不能作为强证据。

## 用户现象（原始描述）

`liuyang_paintbrushes.abr` 里的 `scribbles 2`：

1. 在 WinTab 下会卡，dab 出得不正常。
2. 同样操作在 PointerEvent 正常。
3. 从 PointerEvent 切回 WinTab，偶发“WinTab 完全画不出来”，且切别的笔刷也不恢复，需要重启。

## 本次约束

1. 仅排查，不修改代码。
2. 优先使用现有 debug 工具与 trace 证据链。

## 使用到的工具（已有）

1. Trace 开关：`window.__tabletInputTraceSet(true/false)`  
   定义位置：`src/components/Canvas/useGlobalExports.ts:363`
2. Trace 分析脚本：`scripts/debug/analyze-tablet-trace.mjs`  
   用法位置：`scripts/debug/analyze-tablet-trace.mjs:46`
3. triage 流程说明：`.codex/skills/wintab-trace-triage/SKILL.md:24`

## 数据来源

1. Trace 文件：`C:\Users\LiuYang\AppData\Roaming\com.sutu\debug\tablet-input-trace.ndjson`
2. 笔刷库：`C:\Users\LiuYang\AppData\Roaming\com.sutu\brushes\index.json`
3. 设置：`C:\Users\LiuYang\AppData\Roaming\com.sutu\settings.json`

## 一、分析脚本结果（原始）

执行命令：

```bash
node scripts/debug/analyze-tablet-trace.mjs --tail 12000
```

关键输出：

```text
[Trace] lines_scanned=4507 parsed_rows=4506 skipped_rows=1
[Trace] Top scopes:
  frontend.canvas.dab_emit: 595
  frontend.canvas.consume_point: 591
  frontend.pointermove.dom: 562
  frontend.pointermove.dom_canvas: 562
  frontend.pointermove.native_empty: 551
  frontend.native_pump.consume: 535
  frontend.anomaly.input_without_dabs: 475
  frontend.anomaly.native_missing_with_pointer: 434
  frontend.recv.native_v3: 95
  frontend.pointermove.native_consume: 75
  frontend.pointermove.compare: 11

[Trace] Stroke summary:
  stroke=11 recv_native=57 dom_down=0 dom_move=0 dom_up=0 native_consume=406 pump_start=0 pump_consume=342 canvas_consume=0 tail_consume=0 verdict=NO_DOM_DOWN_BUT_CONSUMED
  stroke=12 recv_native=24 dom_down=0 dom_move=0 dom_up=0 native_consume=122 pump_start=0 pump_consume=121 canvas_consume=0 tail_consume=0 verdict=NO_DOM_DOWN_BUT_CONSUMED
  stroke=13 recv_native=11 dom_down=0 dom_move=0 dom_up=0 native_consume=69 pump_start=0 pump_consume=59 canvas_consume=0 tail_consume=0 verdict=NO_DOM_DOWN_BUT_CONSUMED
  stroke=14 recv_native=3 dom_down=0 dom_move=0 dom_up=0 native_consume=13 pump_start=1 pump_consume=13 canvas_consume=0 tail_consume=0 verdict=CONSUMED_BY_NATIVE_PUMP

[Trace] anomaly counts:
  frontend.anomaly.input_without_dabs: 475
  frontend.anomaly.native_missing_with_pointer: 434
```

## 二、补充统计（同一 trace）

### 1. dab 产出

1. `frontend.canvas.dab_emit` 共 595 次。
2. `phase=move` 590 次。
3. `dabs_count=0` 共 475 次，`dabs_count>0` 共 120 次。
4. 单次最大 `dabs_count=1`。

### 2. native 缺样

1. `frontend.pointermove.native_empty` 共 551 次。
2. `missing_streak`：`p50=35`，`p90=165`，`max=220`。
3. 峰值记录时间：`2026-02-20T01:25:17.664Z`。

### 3. 画布消费队列深度

`frontend.canvas.consume_point.queue_depth`：

1. `count=591`
2. `p50=78`
3. `p90=95`
4. `max=95`

### 4. pointer vs native 偏差峰值

`frontend.pointermove.compare` 中：

1. `maxAbs(delta_last_x)=528.9999847412109`
2. `maxAbs(delta_last_y)=284.99993474121095`
3. 峰值时间：`2026-02-20T01:25:22.867Z`

## 三、关键时序片段（max missing_streak 附近）

时间窗：`2026-02-20T01:25:17.594Z` ~ `2026-02-20T01:25:17.682Z`

观测到：

1. `pointermove.dom` / `pointermove.dom_canvas` 持续发生，pressure=0.5。
2. 同步出现 `pointermove.native_empty`，`missing_streak` 从 209 递增到 220。
3. 同步触发 `anomaly.native_missing_with_pointer`。
4. 在 `2026-02-20T01:25:17.667Z` 开始收到新的 `recv.native_v3`（seq 1704+）。
5. 在 `2026-02-20T01:25:17.675Z` 同一时刻集中出现一批 `pointermove.native_consume`（seq 1704~1715）。

这对应“前面持续拿不到 native 点，随后集中补到一批点”的模式。

## 四、`scribbles 2` 笔刷本体核对

来自 `index.json`：

1. `id = a28d6792-1d92-11db-b6b0-d1244447955b`
2. `name = scribbles 2`
3. `diameter=125`，`spacing=40`
4. `hasTexture=true`，`texture=340x366`
5. `shapeDynamicsEnabled=true`，`angleJitter=298.8`
6. `scatterEnabled=true`，`scatter=62`，`bothAxes=true`
7. `transfer.opacityControl=penPressure`
8. `dualBrushSettings=null`

补充（弱证据，仅事后状态）：  
`settings.json` 当前记录的选中笔刷为 `0096f624-5b63-11df-acac-fc00bbf9a6ab (Sampled Brush 1 5)`。  
但时间戳显示：

1. trace 文件最后写入：`2026-02-20 09:25:25`
2. settings 文件最后写入：`2026-02-20 09:30:36`

因此不能据此反推 `09:25` 采集时你没有使用 `scribbles 2`。

## 五、代码证据定位（未改代码）

### 1. native 缺样异常判定

`src/components/Canvas/usePointerHandlers.ts:445`

1. 使用 native backend 时，`readPointBufferSince(...)` 后若无匹配点，进入 `frontend.pointermove.native_empty`。
2. `missing_streak >= 3` 触发 `frontend.anomaly.native_missing_with_pointer`（`src/components/Canvas/usePointerHandlers.ts:472`）。

### 2. `input_without_dabs` 判定条件

`src/components/Canvas/useBrushRenderer.ts:1266`

触发条件仅为：

1. `dabs.length === 0`
2. `phase in {down, move}`
3. `pressure > 0.001`

未区分高 spacing 场景，因此它可用于“发现异常”，但不能直接当作“必然错误”。

### 3. pointer 会话门控风险点

`src/components/Canvas/usePointerHandlers.ts:1046`

如果已有 `activePointerIdRef` 且与当前 `pointerId` 不同，`processPointerDownNative` 直接 `return`。  
这在“backend 切换 + 上一会话未完整结束”时，存在卡死输入的风险窗口（需要专门复现场景 trace 进一步确认）。

### 4. backend 切换流程未见前端输入会话重置

`src/components/SettingsPanel/index.tsx:524` 仅调用 `switchBackend(...)` 与 `setTabletBackend(...)`。  
`src/stores/tablet.ts:315` 也只是 IPC 切换并刷新状态。  
当前未看到明确的“切换 backend 时强制重置前端 pointer 会话”逻辑。

## 六、当前诊断判断

### 已有较高置信度

1. WinTab 路径存在“pointer 接触有效但 native 点阶段性缺失”的问题。
2. 缺样后会出现批量回补，导致体感卡顿/不连续。
3. 这与用户描述“WinTab 下 dab 不正常，PointerEvent 正常”一致。

### 仍待确认

1. 这次 trace 是否就是 `scribbles 2` 复现段（trace 未记录笔刷 ID，需采集时加外部标记）。
2. “切回 WinTab 后彻底画不出来”是否由 pointer session 残留触发。
3. `input_without_dabs` 中有多少是 spacing 正常行为，多少是真异常。

## 七、建议的下一次采集（仍不改代码）

按以下固定步骤采集一份“只针对 `scribbles 2` + backend 切换”的短 trace：

1. 在控制台执行：`await window.__tabletInputTraceSet(true)`。
2. 选中 `scribbles 2`，backend 设为 PointerEvent，画 3 笔（短横线）。
3. 切到 WinTab，再画 3 笔。
4. 再切回 PointerEvent 画 1 笔，立即切 WinTab 画 1 笔（复现“切回后失效”窗口）。
5. 立刻执行：`await window.__tabletInputTraceSet(false)`。
6. 跑分析：  
   `node scripts/debug/analyze-tablet-trace.mjs --file "C:\Users\LiuYang\AppData\Roaming\com.sutu\debug\tablet-input-trace.ndjson" --tail 12000`

这样可以把“笔刷特异性”和“切换时序问题”拆开验证。

## 八、2026-02-20 10:15 新日志复核（用户标注：第1笔对照，后3笔为 `scribbles 2`）

本次 trace 文件最后写入时间：`2026-02-20 10:15:01`。  
analyzer 总览：

1. `frontend.pointerdown.dom: 4`
2. `frontend.pointermove.native_empty: 313`
3. `frontend.anomaly.native_missing_with_pointer: 254`
4. `frontend.anomaly.input_without_dabs: 294`

按 4 次 `pointerdown -> pointerup` 分段后的结果：

| Session | 时间段(UTC) | native_empty | missing_anomaly | native_consume* | dab_emit | dab_zero | dab_positive | max_missing_streak | stroke_id |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1（对照笔刷） | 02:14:53.591 ~ 02:14:54.110 | 24 | 0 | 104 | 102 | 60 | 42 | 2 | 9 |
| 2（scribbles 2） | 02:14:57.608 ~ 02:14:58.362 | 100 | 98 | 2 | 2 | 1 | 1 | 100 | 11 |
| 3（scribbles 2） | 02:14:59.270 ~ 02:15:00.063 | 89 | 87 | 145 | 145 | 118 | 27 | 89 | 12 |
| 4（scribbles 2） | 02:15:00.663 ~ 02:15:01.333 | 75 | 69 | 118 | 118 | 100 | 18 | 53 | 13 |

\* `native_consume` 这里合并了 `pointermove.native_consume + native_pump.consume + pointerup.native_consume`。

### 本次日志的直接结论

1. 第 1 笔（你标注的对照笔刷）表现明显健康：`missing_anomaly=0`、`max_missing_streak=2`。
2. 后 3 笔（你标注的 `scribbles 2`）异常显著增大：`missing_anomaly` 分别为 `98/87/69`。
3. 第 2 笔最重：`native_empty=100` 且 `native_consume=2`，与“明显卡住、几乎不出点”一致。
4. 第 3、4 笔虽有较多 consume，但 `dab_zero` 比例高（`118/145`、`100/118`），体感会呈现断续和不稳定。

### 额外观测（与4笔主流程并行出现）

trace 中还有一个 `stroke_id=10`，由 `frontend.native_pump.stroke_start` 在无 `pointerdown.dom` 的窗口启动（`dom_inactive_ms=1917.5`）。  
这说明当前链路仍存在“native pump 可独立触发 stroke”的现象，可能会放大会话时序复杂度，但它不是你这 4 笔分段结果的主要解释。

## 九、第一性原理判断（当前证据）

输入链路可拆为四段：

1. WinTab 采样（Rust 轮询线程拿到 packet）
2. Backend 队列出队 + `app.emit("tablet-event-v3")`
3. 前端 `listen('tablet-event-v3')` 收到并写入 `pointBuffer`
4. `usePointerHandlers` / `useStrokeProcessor` 消费并出 dab

基于现有 trace（无新增 emitter 指标版本）：

1. 对照笔刷（stroke 9/10）`host->recv` 延迟是低毫秒级。
2. `scribbles 2`（stroke 11/12/13）`host->recv` 延迟飙到百毫秒级（p90 可达 200~300ms）。
3. 同时存在 `pointermove.dom` 连续发生 + `native_empty` 连续增长 + 后续批量 `recv/native_consume`。

这组特征说明：**WinTab 原始点并非“没产生”，而是在传输/分发链路的中后段被明显延迟，导致前端在一段时间内读不到 native 点。**  
即源头更接近“事件分发时序拥塞（backend emit -> frontend recv）”，而不是画笔插值算法本身。

## 十、新增诊断工具（仅用于定位源头，不改变绘制行为）

为把延迟拆成“采样->emit”和“emit->frontend.recv”两段，已增加：

1. 后端事件：`tablet-emitter-metrics-v1`（每个 emitter batch 一条指标）
2. 前端 trace scope：`frontend.recv.emitter_batch_v1`
3. 分析脚本：`scripts/debug/analyze-tablet-pipeline-lag.mjs`

命令：

```bash
node scripts/debug/analyze-tablet-pipeline-lag.mjs --file "C:\Users\LiuYang\AppData\Roaming\com.sutu\debug\tablet-input-trace.ndjson" --tail 12000
```

输出重点：

1. `frontend.recv.native_v3 (host->recv)`：总延迟
2. `emitter oldest_input_latency (host->emit)`：backend 出队前堆积
3. `emitter transport (emit->frontend.recv)`：emit 到前端监听的分发延迟

判定口径：

1. 若 `host->emit` 高、`emit->recv` 低：瓶颈偏后端队列/出队
2. 若 `host->emit` 低、`emit->recv` 高：瓶颈偏 WebView/前端事件分发
3. 若两者都高：链路双端均拥塞，需要分层治理

## 十一、2026-02-20 10:41 新日志复核（pipeline-lag）

执行命令：

```bash
node scripts/debug/analyze-tablet-pipeline-lag.mjs --tail 12000
```

关键输出（本次）：

1. `frontend.recv.native_v3 (host->recv)`：`p50=85.14ms`，`p90=242.79ms`，`max=357.89ms`
2. `frontend.native_consume (host->consume)`：`p50=13.20ms`，`p90=225.74ms`，`max=321.47ms`
3. `emitter oldest_input_latency (host->emit)`：`p50=1.29ms`，`p90=2.29ms`，`max=2.70ms`
4. `emitter transport (emit->frontend.recv)`：`p50=99.86ms`，`p90=252.81ms`，`max=362.29ms`

延迟最高批次共同特征：

1. `host_to_emit < 3ms`
2. `emit_to_recv > 300ms`

结论：

1. WinTab 采样与后端出队（`host->emit`）正常。
2. 主要卡顿发生在 `emit->frontend.recv` 阶段。
3. 表象是“中间传输慢”，实质更接近“前端/WebView 事件分发排队延迟”。

## 十二、为什么“换笔刷”会影响到看似中间传输

第一性原理拆解：

1. **采样阶段**（笔 -> WinTab -> Rust）本身不依赖具体笔刷。
2. 我们测的 `emit->frontend.recv` 并不只是“线缆传输”，还包含 JS 主线程何时开始执行 `listen('tablet-event-v3')` 回调。
3. 重笔刷会提高前端每帧计算和渲染负载，导致主线程更忙，事件回调更晚执行，形成排队。

因此“只在特定笔刷触发”并不矛盾：

1. `scribbles 2` 参数更重（`spacing=40`、`texture=340x366`、`angleJitter=298.8`、`scatter=62 bothAxes=true`）。
2. 同样 WinTab 输入速率下，它更容易把前端推过拥塞阈值。
3. 对照笔刷没有跨过阈值，所以看起来“没事”。

## 十三、根修方案（不混 PointerEvent 数据）

### 方案目标

1. 保持数据源纯 WinTab（不使用 PointerEvent 补点）。
2. 消除 `emit->frontend.recv` 百毫秒级排队。
3. 修复 backend 切换后偶发“完全画不出”的会话残留问题。

### 方案 A：WinTab 事件批量 IPC（优先实施）

1. 后端从“每点一条 `tablet-event-v3`”改为“每 poll 周期一条 batch 事件”（保序、同源、无补点）。
2. 前端监听 batch 后一次性入 `pointBuffer`，减少 Tauri/WebView 事件分发次数。
3. 该方案只改变传输粒度，不改变点内容和时序顺序。

### 方案 B：前端接收与重计算解耦

1. `listen(...)` 回调仅做轻量入队（O(1)）。
2. 统一在消费泵（现有 pointer/native pump）按预算批量消费，避免回调中执行重逻辑。
3. 目标是降低主线程阻塞导致的回调排队。

### 方案 C：backend 切换时输入会话硬重置

1. 切换 backend 前后强制结束/取消当前笔触会话。
2. 清理 `activePointerId`、native seq cursor、前端点缓冲等会话态。
3. 避免 `activePointerId` 门控导致的“切回 WinTab 后直接 return”卡死窗口。

### 验收指标（修复完成后）

1. `emitter oldest_input_latency (host->emit)`：继续保持低毫秒级（当前已满足）。
2. `emitter transport (emit->frontend.recv)`：`p90` 从 `252.81ms` 显著下降到稳定低双位数毫秒。
3. `frontend.pointermove.native_empty` / `native_missing_with_pointer`：在 `scribbles 2` 复现脚本下显著下降。
4. “PointerEvent -> WinTab 切回后无法绘制”复现率：降为不可复现（至少 20 次切换回归）。

### 实施顺序

1. 先做方案 A（最大化削峰，风险最低）。
2. 再做方案 C（修复切换失效的确定性风险）。
3. 若仍有长尾，再做方案 B（进一步降低主线程拥塞）。

## 十四、补充彻查：为何关闭多项特性后 `scribbles 2` 仍卡、而复杂笔刷可能不卡

用户新增现象：

1. `scribbles 2` 在 UI 中仅开启 `shape dynamics / scattering / transfer`，未启用 Texture 面板。
2. 即便关闭这些面板开关，WinTab 仍可复现卡顿。
3. 另一个更复杂笔刷（`Sampled Brush 5 4`）体感正常。

### 1. “Texture 面板关闭”不等于“不是采样笔尖”

代码口径中有两类不同概念：

1. `hasTexture` / `brushTexture`：表示“采样笔尖（tip image）”。
2. `textureEnabled`：表示 Photoshop 的 Texture 面板（pattern 叠加）。

`BrushPresets` 应用预设时会在 `preset.hasTexture` 为真时始终注入 `brushTexture`（含 `cursorPath`），即使 Texture 面板是关闭的。  
见：`src/components/BrushPanel/settings/BrushPresets.tsx`（`setBrushTexture(...)` 与 `setTextureEnabled(...)` 分离）。

### 2. `scribbles 2` 的 cursor 复杂度显著高于对照笔刷

从 `index.json` 统计：

1. `scribbles 2`
   - `cursorPathLen=219455`
   - `M=545`，`L=14019`
   - `cursorBounds=340x366`
2. `Sampled Brush 5 4`
   - `cursorPathLen=70701`
   - `M=256`，`L=4304`
   - `cursorBounds=138x137`

全库（72 个有 cursorPath 的预设）按 path 长度排名：

1. `scribbles 2` 排第 4（明显离群）
2. `Sampled Brush 5 4` 排第 12

### 3. 关键机制：WinTab 与 PointerEvent 在“归一化前的门控”并不一致

`usePointerHandlers` 两条路径：

1. Native backend（WinTab/MacNative）：
   - 每次 `pointermove` 先 `readPointBufferSince(...)`
   - 若本次没读到 native 点，直接 `native_empty` 并 `return`
   - 见：`src/components/Canvas/usePointerHandlers.ts`
2. PointerEvent backend：
   - 直接消费 `coalescedEvents` 生成点并入队
   - 不依赖 `tablet-event-v3` 到达时序
   - 见：`src/components/Canvas/usePointerHandlers.ts`

因此“后续链路大体一致”只对“已进入队列的点”成立；WinTab 路径多了一个“必须先收到 native 点”的前置门控。

### 4. 为什么会表现成“只在 WinTab 卡”

当前证据更匹配以下链路：

1. `scribbles 2` 的 cursor SVG 路径很重（并且 DOM 光标会渲染两条同路径描边）。
2. 高速移动时主线程负担上升（cursor repaint + 其他前端工作），`tablet-event-v3` 回调执行被排队。
3. WinTab 路径因前置门控更敏感，出现 `native_empty` 连续增长和“晚到批量消费”。
4. PointerEvent 路径不等待 native 回调，体感可保持连续。

这与 `pipeline-lag` 结果一致：

1. `host->emit` 低毫秒级（后端正常）
2. `emit->frontend.recv` 百毫秒级（前端分发/主线程排队）

### 5. 对“关闭 shape/scatter/transfer 仍卡”的解释

关闭上述开关不会移除采样笔尖本身，也不会移除其 `cursorPath`。  
所以该现象并不与“cursor 路径负载”假设冲突。

## 十五、下一步验证（仅验证，不改行为）

1. 同一 `scribbles 2`，仅把笔刷尺寸降到使 `screenBrushSize <= 96`（进入 hardware cursor 路径）后复测 WinTab。
2. 或临时隐藏 DOM brush cursor（仅用于诊断）后复测 WinTab。
3. 若上述任一操作显著降低 `emit->frontend.recv` 与 `native_empty`，可确认“cursor 负载放大 WinTab 门控抖动”是主因之一。

若确认，可进入根修：  
优先做 IPC 批量化 + backend 切换会话硬重置；随后再做 cursor 负载治理（例如复杂路径阈值降级为简化轮廓/椭圆）。

## 十六、用户新反例（2026-02-20）：`scribbles 2` 调大反而不卡

用户新增观察：

1. `scribbles 2` 将 Brush Tip 换成其他 tip 后，WinTab 卡顿消失。
2. `scribbles 2` 本身在“笔刷尺寸调大”后，反而更顺畅。
3. 用户推测与“`<=96` 用 hardware cursor，`>96` 用 DOM cursor”有关。

该反例会削弱“DOM cursor 是主因”的解释，转而支持“hardware cursor 路径问题”。

### 1. 当前代码行为（与该反例一致）

1. 阈值逻辑：`screenBrushSize <= 96` 走 hardware cursor。  
   见 `src/components/Canvas/useCursor.ts`。
2. hardware cursor 路径会把 `cursorPath` 拼成 SVG，再 `btoa` 成 data URL。  
   见 `src/components/Canvas/useCursor.ts` 的 `createCursorSvg(...)`。
3. Canvas 调用处传入的是新对象字面量：  
   `brushTexture ? { cursorPath, cursorBounds } : null`。  
   见 `src/components/Canvas/index.tsx`。
4. `useMemo` 依赖包含 `brushTexture` 对象引用。  
   若父组件发生重渲染，该引用变化会触发重新生成 hardware cursor SVG/data URL。

### 2. `scribbles 2` 的硬件 cursor 数据量显著更大

按当前配置估算（size=64，仅用于对比量级）：

1. `scribbles 2`
   - `cursorPathLen=219455`
   - `hardware cursor svgLen=439289`
   - `hardware cursor data-url 长度=585765`
2. `Sampled Brush 5 4`
   - `cursorPathLen=70701`
   - `hardware cursor svgLen=141781`
   - `hardware cursor data-url 长度=189089`

说明：`scribbles 2` 生成的硬件 cursor URL 量级约为对照 tip 的 3 倍。

### 3. 与 WinTab-only 症状的兼容解释

1. PointerEvent 路径直接消费 DOM/coalesced 输入，不依赖 native IPC 到达后再放行。
2. WinTab 路径在消费前有 `readPointBufferSince(...)` 前置门控，若主线程繁忙导致 native 回调排队，会出现 `native_empty` 连续增长。
3. 当 hardware cursor 生成/应用成本偏高时，更容易把 WinTab 路径推入“回调晚到 -> 缺样 -> 批量回补”的体感。

### 4. 更新后的判断

高置信度：

1. `scribbles 2` 的 tip 特异性主要体现在超长 `cursorPath`（不仅是动态面板开关）。
2. “调大反而不卡”更符合 hardware cursor 阈值切换效应（或至少与其强相关）。

待进一步实证：

1. 当前卡顿的主贡献是“hardware cursor 重建”还是“WinTab IPC 本身排队”，以及二者占比。
2. 在固定 zoom 下仅跨越 `96px` 阈值时，`emit->recv` 是否出现阶跃变化。

### 5. 立即可做的验证（不改业务行为）

1. 固定同一笔刷、同一路径，做两组：`screenBrushSize=95` 与 `97`，比较 `emit->recv` 与 `native_empty`。
2. 固定 `scribbles 2`，仅改变 canvas zoom 使其跨越阈值（不改 brush size），避免“spacing 变大导致 dab 变少”的干扰。
3. 若 `95 -> 97` 后延迟明显下降，可直接锁定 hardware cursor 路径为关键触发器。

## 十七、2026-02-20 新日志复核（用户补充：小笔刷 vs 大笔刷）

执行命令：

```bash
node scripts/debug/analyze-tablet-trace.mjs --tail 12000
node scripts/debug/analyze-tablet-pipeline-lag.mjs --tail 12000
```

### 1. 全局指标

1. `frontend.recv.native_v3 (host->recv)`：`p50=2.01ms`，`p90=70.53ms`，`max=172.24ms`
2. `frontend.native_consume (host->consume)`：`p50=10.53ms`，`p90=116.01ms`，`max=193.52ms`
3. `emitter oldest_input_latency (host->emit)`：`p50=1.30ms`，`p90=2.18ms`，`max=2.68ms`
4. `emitter transport (emit->frontend.recv)`：`p50=0.53ms`，`p90=86.76ms`，`max=182.06ms`

说明：后端采样/出队仍正常，问题仍主要在 `emit->recv` 阶段的前端分发排队。

### 2. 分笔划延迟（关键）

`frontend.recv.native_v3 per-stroke`：

1. `stroke=229`：`avg=62.72ms`，`p90=141.82ms`，`max=172.24ms`
2. `stroke=230`：`avg=37.10ms`，`p90=75.72ms`，`max=84.66ms`
3. `stroke=231`：`avg=5.52ms`（该笔最终 `DROP_BEFORE_CONSUME`）
4. `stroke=232`：`avg=5.36ms`，`p90=6.87ms`，`max=27.75ms`
5. `stroke=233`：`avg=7.00ms`，`p90=6.53ms`，`max=50.29ms`

可以看到明显“前高后低”的分段。

### 3. 时序观察

关键时间点：

1. `03:14:14 ~ 03:14:17`（stroke 229/230）高延迟最明显。
2. 中间有约 `6.4s` 空窗（`03:14:17.263 -> 03:14:23.695`），随后进入下一段。
3. `03:14:25 ~ 03:14:26`（stroke 232/233）延迟显著降低。

这与“你在中间切换小笔刷/大笔刷或调整参数后再画”的操作模式一致（但 trace 本身未记录 cursor 模式标记，仍需人工对应）。

### 4. 对“硬件 cursor 可疑”的支持度

支持点：

1. 本次日志确实表现出两个阶段的延迟统计明显不同。
2. 前段（更差）集中出现 `emit->recv` 高延迟；后段（更好）显著下降。
3. 该模式与“跨过 `screenBrushSize` 阈值后 cursor 实现路径切换”在方向上吻合。

仍待补齐的证据：

1. trace 里尚无 `cursor_mode=hardware/dom` 的直接字段。
2. 因此当前是“高置信关联”，还不是“字段级直接证明”。

### 5. 当前结论更新

1. “`scribbles 2` tip 特异性 + hardware cursor 路径”已是最强可疑根因链之一。
2. 用户新增反例（调大反而不卡）与该假设一致，不支持“仅仅是 brush dynamics 太复杂”的解释。

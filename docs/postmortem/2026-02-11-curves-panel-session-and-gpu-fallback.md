# Curves 面板一期复盘（会话隔离、CPU 兜底、GPU 二期恢复）

**日期**: 2026-02-11  
**范围**: Curves 面板（Ctrl+M）  
**状态**: 一期已可用，GPU 曲线预留二期开关

## 背景

一期目标是先完成可用的曲线工作流：单层、选区内生效、实时预览、OK/Cancel 语义、面板内独立交互。  
上线后出现了几类典型问题：视觉参数有变化但图层不变、快捷键冲突、面板尺寸不稳定、曲线显示锯齿、点拖出边界后行为不符合 PS 习惯。

## 主要问题与根因

### 1. 曲线预览/提交不生效（用户可见）

**现象**: 曲线点和 I/O 数值变化，但画布不变，点击 OK 后也不落盘。  
**根因**: GPU 曲线路径仍处于新链路磨合期，预览与提交虽然有实现，但在当前环境下存在链路不稳定；一期未隔离风险直接暴露给用户。

### 2. 面板内编辑与全局历史冲突

**现象**: 在曲线面板里按 `Ctrl+Z/Delete` 会影响外部画布历史或其他全局行为。  
**根因**: 面板编辑状态没有独立历史栈，且键盘事件未在 capture 阶段优先消费。

### 3. 面板高度体验不稳定（过矮或过高）

**现象**: 有时底部按钮被裁切，有时又出现较大空白。  
**根因**: 浮动面板外层使用固定高度，内部内容又存在固定尺寸区域，导致不同阶段只能靠手调高度，无法自动贴合内容。

### 4. 曲线视觉锯齿明显

**现象**: 曲线边缘“折线感”偏重。  
**根因**: 显示路径采用 256 点离散采样直接连线，采样密度偏低。

### 5. 交互细节与 PS 不一致

**现象**: 控制点拖出曲线框后未删除。  
**根因**: 拖拽状态机没有“出框删除”分支。

## 一期修复策略（已落地）

1. **稳定优先**：保留 GPU 曲线代码，但默认关闭 GPU 曲线开关，曲线会话默认走 CPU，确保“预览可见 + OK 生效”。
2. **会话隔离**：曲线面板引入本地 undo/redo 栈，并在 capture 阶段拦截 `Ctrl/Cmd+Z`、`Ctrl/Cmd+Shift+Z`、`Ctrl/Cmd+Y`、`Delete`。
3. **尺寸策略**：曲线图区域固定像素尺寸；面板层支持 `autoHeight`，曲线面板使用内容自适应高度且禁缩放。
4. **显示优化**：曲线路径改为更高密度采样（1024）+ `geometricPrecision` + round line cap/join。
5. **交互补齐**：非端点控制点支持“拖出曲线框后松手删除”。

## 经验沉淀

### 1. 新 GPU 能力上线必须可熔断

所有新 GPU 编辑能力都应默认具备：

- 独立 feature flag（本地可开关）
- CPU 功能等价兜底
- 会话级路径选择（而非全局即时切换）

### 2. 面板型工具必须有“内部历史”

像 Curves 这类参数编辑工具，本质是“临时编辑会话”，其撤销重做应只影响面板内部参数，不能污染画布全局历史。

### 3. 布局问题优先从容器策略解决

单纯调内容区 CSS 不能修复外层固定高度导致的问题。应先确认容器是否固定高度，再决定是否启用自适应。

### 4. 交互对齐要覆盖“边缘手势”

不仅要实现增点/拖拽/删除键，还要覆盖“拖出边界删除”等高频手势，减少专业用户迁移成本。

## GPU 曲线二期可行性结论

**结论**: 完全可做，当前并非“做不了”，而是“为保证一期稳定先关闭默认入口”。  

建议按以下顺序恢复：

1. 加诊断日志：预览 pass、commit tile 数、readback 成功率。  
2. 建最小回归集：无选区/有选区、不同 blend mode、4K 画布、历史回退。  
3. 先灰度开关（开发构建开启），稳定后再默认启用。  
4. 保持 CPU 兜底常驻，不移除。

## 后续行动项

1. 为 GPU 曲线补充端到端回归（重点验证 commit 后 CPU 读回一致性）。  
2. 在 Debug 面板暴露曲线渲染路径状态（gpu/cpu）与失败回退计数。  
3. 若后续支持多层曲线，沿用“会话锁定 + 单条历史提交”的提交语义。

## 补充复盘（RGB + 单通道叠加，2026-02-11）

### 1. 现象

在 RGB 与单通道（R/G/B）同时存在控制点时，单独看 RGB 或单通道都接近 PS，但叠加结果与 PS 偏差明显。

### 2. 根因

CPU 与 GPU 路径都采用了 `RGB -> 单通道` 的映射顺序，而 PS 实测更接近 `单通道 -> RGB`。  
顺序不同会导致叠加曲线在中高斜率区域出现系统性偏差，且 GPU/CPU 会一致“错”。

### 3. 修复

1. CPU 曲线应用顺序改为 `red/green/blue LUT` 先作用，再应用 `rgb LUT`。  
2. GPU `tileCurvesComposite.wgsl` 同步改为同一顺序，避免预览与提交不一致。  
3. 新增叠加场景回归样本：`RGB+Red`、`RGB+Green`、`RGB+Blue` 三组（其中一组保留 ±2 容差）。  

### 4. 新经验

1. 仅验证 `RGB-only` 或 `Channel-only` 不能证明“叠加语义”正确。  
2. 曲线对齐必须有“组合样本集”，至少覆盖：
   - `RGB-only`
   - `R-only / G-only / B-only`
   - `RGB+R / RGB+G / RGB+B`
3. 样本采集需同时记录：
   - 通道名（避免误把 Blue 记成 Green）
   - 控制点 Input/Output
   - Before/After 颜色值（同一像素）
   - Curves 模式（Light 0-255）

## 补充复盘（UI 对齐：精确输入 + 通道叠加可视化，2026-02-11）

### 1. 现象

1. 面板底部 `Input/Output` 只能显示文本，无法像 PS 一样精确输入数值。  
2. 单通道编辑时曲线仍是白色，不利于快速识别当前通道。  
3. 在 `RGB` 视图下，用户看不到已调整的单通道曲线，导致“参数已生效但图上不可见”的理解成本。

### 2. 修复

1. `Input/Output` 改为数字输入框，支持 `Blur/Enter` 提交；输入值按控制点合法范围自动夹取。  
2. 主曲线颜色按通道着色：`Red/Green/Blue` 分别显示红/绿/蓝，`RGB` 保持白色。  
3. `RGB` 视图增加单通道叠加曲线显示，仅在该通道 LUT 非 identity 时展示。  
4. `RGB` 视图下彩色叠加线展示“单通道原始曲线形态”，不随 RGB 曲线变形（与 Photoshop 一致）。

### 3. 新经验

1. 曲线工具“可解释性”不只靠数值正确，还依赖 UI 对曲线来源语义的可视化。  
2. 像素应用顺序与 UI 叠加展示语义是两个维度：  
   - 计算链路应保持 `单通道 -> RGB`  
   - RGB 视图下彩色叠加线应保持各单通道原始曲线形态  
3. 数值输入框要和拖拽规则共用同一套约束（端点锁定、邻点防穿越），避免两套编辑路径产生不一致结果。

## 补充复盘（RGB 视图叠加线形态修正，2026-02-11）

### 1. 现象

当先调整单通道（如 Red）再调整 RGB 时，RGB 视图里的彩色叠加线会跟随 RGB 曲线变形，用户无法看到 Red 通道原始曲线形态。

### 2. 根因

RGB 视图叠加线误用了复合评估（`channel -> rgb`）来绘制路径，导致展示层把“最终像素映射”与“单通道曲线形态显示”混在一起。

### 3. 修复

1. RGB 视图叠加线改为直接绘制 `red/green/blue` 各自 evaluator 的原始路径。  
2. 保持像素计算链路不变：仍按 `单通道 -> RGB` 执行。  
3. 新增回归用例：修改 RGB 曲线后，单通道叠加线 `d` 路径保持不变。

### 4. 新经验

1. “与 PS 一致”需要分别验证“结果一致（像素）”和“展示一致（UI 语义）”。  
2. 曲线面板测试集应单独包含“RGB 修改不会改变彩色叠加线形态”的断言。

## 补充复盘（Fail-Fast 策略，2026-02-11）

### 1. 背景

此前曲线会话在 GPU 提交失败时会自动走 CPU 提交兜底。  
这种“静默降级”虽然提升了短期可用性，但会掩盖真实 GPU 问题，导致研发误判为“功能正常”。

### 2. 改动

1. 曲线桥接协议改为结构化结果（`preview/commit` 都返回 `ok/error/code/stage`）。  
2. GPU 预览失败后进入 `preview halted`，停止继续尝试 GPU 预览，并在面板内显示详细错误。  
3. GPU 提交失败时不再自动 CPU 回退，默认保持图像不变并返回失败。  
4. 仅保留“手动二次确认 CPU 提交”作为应急路径：第一次点击进入确认态，第二次才真正执行 CPU 提交。  
5. 诊断日志统一为 `[CurvesGpuFailFast]`，记录 `sessionId/layerId/stage/code/error`。

### 3. 新经验

1. 对高风险新链路，默认应优先暴露错误而不是掩盖错误。  
2. 自动兜底应仅用于面向普通用户的发布策略，不应干扰研发阶段问题定位。  
3. “Fail-Fast + 手动应急通道”可以兼顾可修复性与可恢复性。

## 补充复盘（GPU 曲线无选区时预览/提交无效果，2026-02-11）

### 1. 现象

在无选区状态下，曲线面板可正常拖点，但画布预览基本不变化；点击 `OK` 后也可能“看起来提交成功但图像不变”。

### 2. 根因

`tileCurvesComposite.wgsl` 对 `selection_tex` 的采样使用了全局画布坐标直接 `textureLoad`。  
无选区时绑定的是 `1x1` 白色 selection mask，越界坐标会导致采样值退化为 `0`，相当于把曲线效果整体乘没。

### 3. 修复

1. 在曲线 shader 中补齐 selection 坐标夹取：先取 `textureDimensions(selection_tex)`，再对 `global_xy` 做 `min(dim - 1)`。  
2. 同时补齐 `global_xy` 与 `dst_tex` 的边界保护，避免越界读取引入未定义行为。  
3. 新增回归测试：`src/gpu/layers/tileCurvesCompositeShader.test.ts`，锁定“必须使用 clamped selection 采样”。

### 4. 新经验

1. 任何使用“全局坐标采样 selection mask”的 shader，都必须做基于 `textureDimensions` 的坐标夹取。  
2. 不能假设 selection 纹理总是与画布同尺寸；无选区时通常是 `1x1` 常量纹理。  
3. “GPU 成功执行但视觉无变化”也要优先排查 mask/采样坐标链路，而不只盯异常日志。

## 补充复盘（有选区时白边与预览卡顿，2026-02-11）

### 1. 现象

1. 有选区时，曲线预览在选区周围出现一圈白边/透明边。  
2. 拖动曲线点时明显掉帧，主观体感接近 CPU 路径。

### 2. 根因

1. 预览链路在 `dirtyRect` 小于整 tile 时，没有保留 tile 的选区外像素：  
   `renderLayerStackFrame(...curvesPreview/gradientPreview...)` 里对 `activePreviewView` 使用了 `loadOp: clear`，但没有像 commit 路径一样先拷贝原 tile 并 `loadExistingTarget`，导致选区外区域被清空。  
2. 曲线 GPU 预览每帧都在调用 `setSelectionMask(session.selectionMask)`，导致选区 mask 每帧全量上传 GPU（`writeTexture`），大选区时造成明显性能回退。

### 3. 修复

1. 在预览路径（gradient + curves）补齐“保留选区外像素”逻辑：  
   - 先判断 `preserveOutsideDirtyRegion = !isFullTileDraw(previewDrawRegion, rect)`  
   - 若为真，先 `copyTextureToTexture(activeSource.texture -> activePreviewTexture)`  
   - 预览 pass 使用 `loadExistingTarget: preserveOutsideDirtyRegion`  
2. 选区 mask 上传改为“会话初始化时一次”：
   - `beginCurvesSession`（GPU 模式）时设置一次 `setSelectionMask(selectionMaskSnapshot)`  
   - 移除 `renderCurvesPreviewGpu` 与 `commitCurvesGpu` 内每次调用的重复设置  
   - 会话结束后继续按既有逻辑恢复全局 selection mask。

### 4. 回归

1. 新增 `src/gpu/layers/GpuCanvasRenderer.previewSelection.test.ts`，锁定预览路径必须启用 `preserveOutsideDirtyRegion + loadExistingTarget`。  
2. 保留 `src/gpu/layers/tileCurvesCompositeShader.test.ts`，继续覆盖 selection 采样坐标夹取。

## 补充复盘（GPU 曲线历史错位与撤销跨步，2026-02-11）

### 1. 现象

1. 曲线提交后 `Ctrl+Z` 首次无效（需再次触发才回撤）。  
2. 在“选区变更 + 再次曲线提交”场景中，单次撤销可能表现为跨步回退。  
3. 曲线历史条目在时间线上表现不稳定，和选区历史交错异常。

### 2. 根因

曲线 GPU 提交路径直接读取 `pendingGpuHistoryEntryIdRef` 作为历史 entryId。  
该 ref 的生命周期由笔刷/渐变链路维护；当曲线会话与当前工具状态不一致时，可能出现“读到 stale entryId 或读不到本次 entryId”的情况，导致 GPU 历史快照与 `pushStroke` 入栈条目不一致。

### 3. 修复

1. 在 `useLayerOperations` 新增 `getCapturedStrokeHistoryMeta()`，统一从 `captureBeforeImage` 的捕获结果读取 `entryId/snapshotMode/layerId`。  
2. `commitCurvesGpu` 与 `commitGradientGpu` 改为使用该元数据决定是否附加 GPU history capture，不再直接依赖 `pendingGpuHistoryEntryIdRef`。  
3. 曲线 CPU 提交失败分支补 `discardCapturedStrokeHistory()`，避免残留捕获基线污染后续入栈。

### 4. 回归

新增 `src/components/Canvas/__tests__/curvesHistoryWiring.test.ts`，锁定曲线/渐变 GPU 提交均通过 `getCapturedStrokeHistoryMeta()` 取历史元数据。

## 补充复盘（曲线撤销不稳定与快捷键重复触发，2026-02-11）

### 1. 现象

1. 曲线提交后，`Ctrl+Z` 偶发“第一次没反应”或一次回撤多步。  
2. 有选区时更容易出现“看起来历史位置错乱、撤销跨步”。

### 2. 根因

1. GPU 历史链路在个别情况下会出现 `GPU history apply` 失败；原实现里 GPU 条目默认不带 CPU `beforeImage`，失败后只能告警，无法回退。  
2. 全局快捷键对 `Ctrl/Meta` 组合没有过滤 `keydown.repeat`，在卡顿场景下可能把一次长按识别为多次撤销。  
3. Curves 面板会话结束到卸载之间存在极短窗口，面板级键盘拦截仍可能吞掉一次全局撤销。

### 3. 修复

1. `captureBeforeImage(true, true)`：GPU 提交时同时保留 CPU `beforeImage` 备份（仅提交阶段），确保 GPU 历史 apply 失败时仍可 CPU 回撤。  
2. `useKeyboardShortcuts` 对 `Ctrl/Meta` 组合新增 `e.repeat` 过滤，并在 `Ctrl+Z/Ctrl+Y` 添加 `stopPropagation`，避免重复触发。  
3. Curves 面板键盘处理增加 `sessionId` 有效性门禁，会话结束后不再拦截 `Ctrl+Z/Ctrl+Y`。

### 4. 回归

1. `src/components/Canvas/__tests__/useKeyboardShortcuts.test.ts` 新增 repeated `Ctrl+Z` 用例。  
2. `src/components/Canvas/__tests__/curvesHistoryWiring.test.ts` 新增断言：曲线/渐变 GPU 提交路径必须走 `captureBeforeImage(true, true)`。

## 状态更新（曲线历史问题仍未解决，2026-02-11）

### 1. 最新用户反馈

1. 曲线历史在真实交互里“仍然不行”，撤销行为依然混乱。  
2. 当前现象与前述问题一致：撤销有时生效、有时不生效，历史位置不稳定。  
3. 其他工具历史正常，异常集中在曲线链路。

### 2. 经验与教训

1. 仅靠 wiring 级单测（entryId 绑定、快捷键 repeat 过滤）不足以覆盖“多轮选区 + 曲线 + 撤销”的真实时序。  
2. 曲线历史问题高度依赖交互顺序与异步时机，必须补端到端的历史时间线验证，而不能只看局部函数逻辑。  
3. Postmortem 必须区分“代码改动已提交”和“问题已真正关闭”，避免把“部分缓解”误记为“已修复”。

### 3. 下一轮排查重点（待执行）

1. 增加运行时历史时间线日志：每次 `pushSelection/pushStroke/undo/redo` 记录 entry 类型、entryId、selection 快照摘要与时间戳。  
2. 用固定脚本复现两条链路并抓日志对比：  
   - 无选区：连续两次曲线提交 + 连续撤销  
   - 有选区：切换选区后两次曲线提交 + 连续撤销  
3. 检查 `selection` 异步构建完成时机与曲线提交时机是否发生竞态，确认是否存在“历史先后顺序写错位”。

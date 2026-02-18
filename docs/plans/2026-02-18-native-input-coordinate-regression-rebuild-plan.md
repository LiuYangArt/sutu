# WinTab 输入链路彻底重构计划（无 Fallback，统一到单一路径）

**日期**：2026-02-18  
**状态**：Draft v1（待执行）  
**决策**：不再做局部修补，直接重建输入融合链路（Input Fusion V3），一次切换到单一路径。

---

## 0. 直接结论（Implementation Plan）

1. 当前 `pointerevent` 手感好、`wintab` 手感差，不是笔刷主算法的问题，核心是“输入融合层”语义不一致。  
2. 必须重建 `WinTab + PointerEvent` 的融合系统：  
   - 几何坐标只认 PointerEvent。  
   - 压力/倾角/旋转只认 native 样本。  
   - 用“时间戳最近邻匹配 + 单笔时序状态机”，替代当前“按数组索引配对”。  
3. 运行时只保留一条生产路径，不保留 fallback 或旧路径开关。  
4. 本计划目标是在不改 GPU 渲染主架构的前提下，让 WinTab 达到与 PointerEvent 同等级稳定性，并对齐 Krita 的压感尾段连续性。

计划置信度：`0.90`（风险主要在 WinTab live 设备差异与 phase 合成边界）。

---

## 1. 问题定义（现状）

用户实测问题（WinTab）：
1. 偶现丢笔（局部缺段）。  
2. 尖尾缺失（收笔不自然、尾段发硬）。  
3. 压力突变，出现不均匀锯齿感。  

对照现象：
1. 同笔刷参数下，`pointerevent` 已达到可接受手感。  
2. Krita 的 WinTab 路径表现稳定，说明“WinTab 本身不可用”不是根因。

---

## 2. 根因证据（来自当前实现）

1. **样本配对错误**：当前 native 样本与 pointer 样本按“尾部索引”硬配，不按时间对齐。  
   - `src/components/Canvas/usePointerHandlers.ts`  
   - `src/components/Canvas/useRawPointerInput.ts`  
2. **近期样本截取存在污染风险**：contact 切片在 `hover/up` 尾部场景可能回退整段历史。  
   - `src/components/Canvas/usePointerHandlers.ts`  
   - `src/components/Canvas/useRawPointerInput.ts`  
3. **WinTab phase 语义弱**：Rust 端 WinTab 仅发 `move/hover`，缺少真实 `down/up`。  
   - `src-tauri/src/input/wintab_backend.rs`  
4. **Rust 侧额外 pressure 平滑叠加**：会在临界压力段引入台阶和响应迟滞。  
   - `src-tauri/src/commands.rs`  
5. **收笔窗口队列治理仍有“清空旧点”路径**：在状态边界下可能造成局部缺段。  
   - `src/components/Canvas/useStrokeProcessor.ts`

结论：问题集中在“输入采样与融合层”，不是 `KritaPressurePipeline` 核心公式。

---

## 3. 目标、非目标、成功标准

### 3.1 目标

1. 重建输入融合为单一路径，彻底消除 WinTab 与 PointerEvent 的手感分叉。  
2. WinTab 达到：连续、可控、尾段自然、无明显台阶。  
3. 保持现有 GPU-first 渲染架构与 `KritaPressurePipeline` 主干不变。  

### 3.2 非目标

1. 不重做 Brush UI。  
2. 不引入 iPad 路径改造。  
3. 不保留旧路径 fallback 或运行时双轨并行。

### 3.3 成功标准（全部满足）

1. WinTab 实测四场景通过：`slow_lift / fast_flick / abrupt_stop / low_pressure_drag`。  
2. WinTab 与 PointerEvent 的压力轨迹误差收敛（同输入回放）：  
   - `pressure_delta_p95 <= 0.03`  
   - `tail_continuity_break_count = 0`  
3. 无丢笔：`stroke_gap_count = 0`（定义见 8.4）。  
4. `pnpm check:all` 与 `cargo check --manifest-path src-tauri/Cargo.toml --lib` 通过。  
5. 删除旧融合路径后，生产代码无 legacy 可达分支。

---

## 4. 方案对比（Plan Mode 选型）

### 方案 A（推荐）：Pointer 几何主权 + Native 传感器主权 + 时间对齐融合

效果/用途：
1. 保留已验证稳定的几何来源（PointerEvent）。  
2. 充分利用 WinTab 压力与传感器。  
3. 用时间匹配替代索引匹配，直接解决压力锯齿与尾段断裂。

优点：
1. 风险最可控，改造范围集中在融合层。  
2. 不依赖 native 几何坐标契约冻结。  
3. 与当前 postmortem 的“Pointer 几何稳定语义”一致。

缺点：
1. 需要严格处理两时钟域对齐。  
2. 需要重写当前 handlers/raw 输入聚合逻辑。

### 方案 B：纯 WinTab 几何 + 纯 WinTab 传感器（仿 Krita）

效果/用途：
1. 彻底摆脱 PointerEvent 对绘制的参与。  
2. 架构上最接近 Krita 单链路模型。

优点：
1. 理论上模型最纯。  
2. 后续跨端概念更统一。

缺点：
1. 需要先冻结 native 坐标单位/原点/缩放契约。  
2. 当前历史问题说明该风险很高，短期成功率低。

### 方案 C：继续局部修补（否决）

效果/用途：
1. 小改快试。

缺点：
1. 已被实践证明成本更高、回归更多。  
2. 无法根治系统性问题。

**最终选型**：方案 A。

---

## 5. 目标架构（Input Fusion V3）

### 5.1 单笔数据模型

新增统一事件契约（前端）：
1. `GeometrySample`：`x/y/pointer_id/phase/host_time_us`（仅 PointerEvent）。  
2. `SensorSample`：`pressure/tilt/rotation/source/device_time_us/host_time_us`（仅 native）。  
3. `UnifiedInputSampleV3`：融合后输出给 `KritaPressurePipeline` 的唯一输入。

### 5.2 融合规则（强约束）

1. 几何坐标永远来自 `GeometrySample`。  
2. 每个几何点从同 pointer_id、同 stroke_id 的传感器序列中，按 `host_time_us` 做最近邻匹配。  
3. 超过 `max_sensor_skew_us`（默认 12ms）时，按“保持最近合法传感器值”策略，不允许跨笔借样。  
4. phase 主权来自 PointerEvent（`down/move/up`），native phase 仅用于过滤 `hover`。  
5. 收笔 `up` 必须消费 pending segment，禁止尾段漏样。

### 5.3 模块落位

1. `src/engine/inputFusionV3/types.ts`  
2. `src/engine/inputFusionV3/strokeSession.ts`  
3. `src/engine/inputFusionV3/temporalJoiner.ts`  
4. `src/engine/inputFusionV3/unifiedInputAssembler.ts`  
5. `src/engine/inputFusionV3/testing/unifiedInputGate.ts`

### 5.4 旧代码处置（无 fallback）

1. `usePointerHandlers/useRawPointerInput` 不再自行做 native-pointer 混配。  
2. 旧 `nativeStartIndex + eventIndex` 路径删除。  
3. 旧 runtime 模式开关删除，不再支持 legacy 主路径。

---

## 6. Rust 侧配套重构（必须）

1. `wintab_backend.rs`：
   - 保留高频采样。  
   - 输出字段严格单调：`seq/host_time_us/device_time_us/source/pressure/tilt/rotation`。  
   - 不再承担 UI 几何映射逻辑。  
2. `commands.rs`：
   - 删除 emitter 线程中的压力平滑（`PressureSmoother` 不再作用于生产链路）。  
   - 保留可观测指标与队列指标上报。  
3. backpressure 固定 `lossless`，并将 dropped 指标设为硬门禁。  
4. `push_pointer_event` 仍保留用于 Pointer backend，不参与 WinTab 绘制融合主链。

---

## 7. 分阶段执行计划（无回退开关）

### Phase 0：冻结口径

1. 固定设备、驱动、画布、笔刷预设。  
2. 增加 WinTab live 采样基线（不是仅 replay capture）。  
3. 定义输入级指标：`sensor_skew_us / pressure_jump_rate / gap_count`。

### Phase 1：契约与模块骨架

1. 落地 `inputFusionV3` 类型与接口。  
2. 补齐单测骨架（时间匹配、跨笔隔离、up 消费）。

### Phase 2：前端融合重写

1. `usePointerHandlers` 只产出几何事件。  
2. native 缓冲读取只产出传感器事件。  
3. `unifiedInputAssembler` 生成唯一 `UnifiedInputSampleV3` 入队。

### Phase 3：Rust 事件通道瘦身

1. 下线生产 pressure smoothing。  
2. 校验队列无 dropped；若 dropped > 0 直接 gate fail。

### Phase 4：接入绘制主链

1. `useStrokeProcessor` 仅消费统一样本队列。  
2. `useBrushRenderer` 保持 `KritaPressurePipeline` 输入契约不变。  
3. 删除旧融合分支和 legacy 配对代码。

### Phase 5：门禁与实测

1. 自动门禁：输入级 + stage/final/fast 全通过。  
2. 手测矩阵：WinTab 与 PointerEvent 同笔刷对比。  
3. 通过后一次切主，不保留 fallback。

---

## 8. Task List（按执行顺序）

1. [ ] 新建 `src/engine/inputFusionV3/types.ts`（Geometry/Sensor/Unified 三类样本）。
2. [ ] 新建 `src/engine/inputFusionV3/strokeSession.ts`（pointer_id + stroke_id 生命周期）。
3. [ ] 新建 `src/engine/inputFusionV3/temporalJoiner.ts`（最近邻时间匹配 + skew 限制）。
4. [ ] 新建 `src/engine/inputFusionV3/unifiedInputAssembler.ts`（融合入口）。
5. [ ] 新建 `src/engine/inputFusionV3/testing/unifiedInputGate.ts`。
6. [ ] 重构 `src/components/Canvas/usePointerHandlers.ts`：仅发几何事件，不做 native 索引配对。
7. [ ] 重构 `src/components/Canvas/useRawPointerInput.ts`：与 handlers 共享统一 assembler。
8. [ ] 删除 `nativeStartIndex + eventIndex` 相关逻辑。
9. [ ] 重写 `selectRecentNativeStrokePoints`，确保不会跨笔回捞历史样本。
10. [ ] 为 `selectRecentNativeStrokePoints` 补充跨笔污染回归测试。
11. [ ] 改造 `src/components/Canvas/useStrokeProcessor.ts` 队列消费，禁止状态边界静默丢点。
12. [ ] 为 `finishing` 阶段补“尾段必消费”测试。
13. [ ] `src-tauri/src/commands.rs` 下线 emitter 线程 pressure smoothing。
14. [ ] `src-tauri/src/input/wintab_backend.rs` 校验 `host/device` 时间单调性并补日志。
15. [ ] `src/stores/tablet.ts` 增加 queue metrics 观测输出（调试可见）。
16. [ ] 新增输入门禁脚本 `scripts/pressure/run-input-fusion-gate.mjs`。
17. [ ] 门禁新增指标：`sensor_skew_p95_us`。
18. [ ] 门禁新增指标：`pressure_jump_rate`（每 1000 点压力突变次数）。
19. [ ] 门禁新增指标：`stroke_gap_count`。
20. [ ] 门禁新增指标：`tail_terminal_pressure_delta`。
21. [ ] 跑 WinTab live case A~H 并落盘 artifacts。
22. [ ] 跑 PointerEvent 同 case 作为对照 artifacts。
23. [ ] 对比 WinTab vs PointerEvent 指标差异，确认收敛。
24. [ ] 删除旧融合路径不可达代码。
25. [ ] 清理 legacy runtime mode 与文档。
26. [ ] 执行 `cargo check --manifest-path src-tauri/Cargo.toml --lib`。
27. [ ] 执行 `pnpm check:all`。
28. [ ] 输出最终验收报告（含手测截图与指标表）。

---

## 9. 验证方案（如何手动验证）

1. 进入设置，后端切到 `wintab`，固定同一笔刷预设（size/spacing/flow/opacity/hardness）。  
2. 画 3 组笔触：慢抬笔、快速甩笔、突然停笔。  
3. 预期结果：  
   - 无明显断段（不出现“空白缺口”）。  
   - 尾段连续变细，不出现硬截断。  
   - 同力度下宽度变化平滑，无台阶锯齿。  
4. 切到 `pointerevent` 用同样动作重复。  
5. 预期结果：两组手感接近，不再出现 WinTab 明显劣化。

---

## 10. 风险与对策

1. 风险：WinTab 设备时间与 host 时间抖动大，导致错配。  
   对策：统一以 `host_time_us` 匹配，`device_time_us` 仅用于诊断。  
2. 风险：高频输入下队列积压。  
   对策：`lossless` + dropped 硬门禁 + p95 延迟监控。  
3. 风险：删除旧路径后回归面扩大。  
   对策：先补输入层单测与门禁，再切主并同日全量检查。

---

## 11. Thought（关键判断依据）

1. 现有问题是融合层时序与配对错误，不是单个公式错误。  
2. 继续 patch 会继续放大隐式状态机复杂度，时间成本更高。  
3. “几何主权/传感器主权/phase 主权”先契约化，才能稳定落地。  
4. 单一路径、无 fallback 才能真正终止回归反复。


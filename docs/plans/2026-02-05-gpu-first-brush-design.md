# GPU-First 笔刷与渲染架构设计（8K 目标，Tile 化）

**日期**：2026-02-05
**状态**：设计草案（已对齐）

## 1. 目标与成功标准

### 目标

- 显示分辨率以 **4K** 为主，画布分辨率 **最低 4K**。
- **32GB NVIDIA 台式显卡**：画布目标上限 **8K**。
- **4060 移动版**：画布目标上限 **4K**。
- 彻底移除 **GPU→CPU readback + CPU 合成** 作为实时绘画路径。
- **可见层数不设上限**，视觉正确性不因配置而变化。
- 通过 **tile/虚拟纹理** 控制显存常驻与带宽压力。

### 成功标准

- 32GB 显卡：8K 画布单层连续 30s 绘画，无停画、无 WebGPU ValidationError、输入延迟稳定。
- 4060 移动版：4K 画布同样满足上述稳定性指标。
- 4K 对比当前 Canvas2D：误差可控（8-bit 误差 ≤ 1~2，且可解释）。
- 可见层数增加时，视觉结果正确，且显存峰值可控（tile 常驻上限稳定）。
- 导出/截图仅在用户触发时 readback，颜色一致。

## 2. 非目标（本阶段不做）

- 不追求像素级完全一致（允许极小误差并可解释）。
- 不做多实例/网络协作画布。
- 不在实时绘画中执行任何 readback。
- 不要求“全画布全层纹理常驻显存”。

## 3. 核心决策

### 3.1 纹理格式策略（已定）

- **Layer 存储**：`rgba8unorm`（线性空间）
- **Active stroke scratch**：`rgba16float`
- **显示输出**：线性 → sRGB
- **导出/截图**：显式 readback，仅在需要时执行

理由：`rgba32float` 在 8K 下显存/带宽不可接受；`rgba8unorm` 作为最终目标格式更合理，`rgba16float` 仅在 active stroke 期间保障混合精度。

补充（需验证）：

- **线性 8-bit 暗部 banding 风险**：`rgba8unorm` 存线性时，暗部精度最差，必须依赖 dither 才能压住 banding。
- **备选存储**：`rgba8unorm-srgb`（读取自动解码到线性）。优点是暗部感知精度更高；但 **sRGB 格式不能作为 storage texture**，因此写回 layer 需要走 render pass（color attachment）或额外转换 pass。
- 结论：M0 里做 `rgba8unorm (linear + dither)` vs `rgba8unorm-srgb` 的对比基准，再最终锁定。

### 3.2 Tile/虚拟纹理（新增）

- 画布按固定 **tile** 切分（建议 256 或 512）。
- 每层由 **tile 纹理集合** 表示，非活动层不做全画布常驻。
- 采用 **LRU** 或相似策略控制 GPU 常驻 tile 数量。
- **Tile 边界采样策略（必须显式处理）**：
  - 合成/commit 走 `textureLoad`（整数坐标）以避免 filtering 引入的边缘伪影。
  - 显示缩放（linear filtering / mip）需要 **tile padding（推荐 1px border）** 或 shader 手动 clamp，否则 zoom out 时容易出现接缝。

### 3.3 可见 tile 合成缓存（新增）

绘画只发生在 active layer，但需要正确显示上下层。因此引入可见 tile 缓存：

- `belowComposite`：active layer 之下所有层 **可见 tile** 合成缓存。
- `aboveComposite`：active layer 之上所有层 **可见 tile** 合成缓存。
- 缓存是 **tile 化** 的，且作用域仅覆盖 **当前 viewport 的可见 tiles**（不维护整张 8K 全画布离屏缓存）。
- 缓存仅在对应 tile 的层内容/属性（opacity/blend/visibility/顺序）变化，或 viewport 变化导致可见 tile 集合变化时失效/重建。

### 3.4 降级策略（新增）

- **优先**降画布分辨率（8K → 6K → 4K）。
- **其次**降低离屏缓存保留时间或降低离屏缓存精度。
- **不降低可见层数**，保证视觉正确性。

### 3.5 同纹理读写冲突修复（新增）

`commitStroke()` 不能在同一 pass 中对 `activeLayer` 既读又写：

- 为 active layer 引入 **`activeLayerTmp`**（或 ping-pong）。
- 提交路径：`activeScratch + activeLayer -> activeLayerTmp`，然后交换句柄。
- `commitStroke()` **只处理 dirty tiles**（由 stroke 的 tile 覆盖集合决定），并尽量使用 scissor / AABB 限制 dispatch 范围。

### 3.6 设备能力探测（新增）

- 启动时探测 `maxTextureDimension2D`、格式支持、可用显存预算。
- 超出上限时按 3.4 规则降级。
- 显存预算不要仅依赖静态信息：增加 **allocation probe（逐步分配 + submit）** 估计浏览器实际可用上限，并将 LRU 预算设为该上限的 **60%~70%**。
- 需要明确 **device lost / OOM** 的用户态恢复策略（清缓存 → 降级 → 切换 fallback）。

## 4. 架构概览

### 4.1 模块划分

1. **GpuLayerStore**
   维护每层 tile 纹理、可见性/opacity/blendMode 元数据。

2. **TileResidencyManager（新增）**
   维护 tile 常驻预算、LRU、上传/回收与系统内存缓存。

3. **GpuLayerComposer**
   维护 `belowComposite`、`aboveComposite`、`display` 的 **可见 tile 缓存**；负责合成。

4. **GPUStrokeAccumulator（改造）**
   输出到 `activeScratch (rgba16float)` 的 **可见 tile**；`commitStroke()` 合成回 active layer。

5. **WebGPU Display**
   直接显示 `display` tile 集合（不经 CPU Canvas2D）。

### 4.2 数据流

- 输入点 → `GPUStrokeAccumulator` 写入 **scratch tiles**
- 每帧合成：对 **可见 tile 集合** 进行
  `belowComposite + activeScratch + aboveComposite -> display`
- 结束笔触：对涉及的 tiles 执行
  `activeScratch + activeLayer -> activeLayerTmp`，然后 swap
- 导出/截图：通过 GPU 进行 **tile-based 合成 + 线性→sRGB + dither**，再 readback（非实时）

## 5. 关键接口变化（Breaking）

1. **LayerRenderer.composite()**
   由 `GpuLayerComposer` + tile 缓存替代，Canvas2D 仅作为 fallback。

2. **Preview 路径**
   `getPreviewCanvas()` 不再是 CPU canvas，改为 GPU display surface。

3. **导出/截图 API**
   新增显式 `readbackExport()`；禁止在绘画中隐式 readback。

## 6. 色彩与精度处理

### 6.1 颜色空间

- Layer 与 scratch 在 **线性空间** 混合。
- Display 输出进行线性 → sRGB。

### 6.2 抖动（Dither）

在 `rgba16float → rgba8unorm` 写回时加入轻量抖动（Bayer 4x4 / 蓝噪）以减少 banding。

### 6.3 导出一致性（新增）

导出统一走：`linear -> sRGB8 + dither` 的 GPU pass，再 readback。
禁止从 `activeLayer` 直接 readback，以避免色彩路径不一致。

## 7. 里程碑与验收

### M0：设备能力探测 + 基线

- 探测 `maxTextureDimension2D`、格式支持、显存预算
- 8K/4K 分配与 clear/compose micro-benchmark
- `rgba8unorm (linear + dither)` vs `rgba8unorm-srgb` 的视觉与误差基准（叠加多次、暗部、渐变）
- allocation probe + device lost/oom 最小恢复路径原型（至少能降级继续画）

### M1：Tile 基础设施与显示

- tile 切分 + LRU 常驻
- 仅显示单层 tile 纹理
- 空 tile 不分配：tile 索引使用稀疏结构（Map/Hash）存储

### M2：GPU 合成最小集

- normal + opacity + visibility
- `below/above` 可见 tile 缓存机制

### M3：GPU 笔刷写入 scratch + commit

- `GPUStrokeAccumulator` 直写 `rgba16float` tiles
- `commitStroke()` ping-pong/临时纹理方案
- scissor / AABB 驱动的局部 dispatch（只覆盖 dirty rect）

### M4：主要特性恢复

- dual / texture / wet-edge / scatter
- 回归一致性验证

### M5：Selection/Mask GPU 化 + 导出

- selection 纹理化
- 显式 readback（导出路径一致性）

## 8. 风险与对策

1. **色彩一致性偏差**
   - 对策：建立小画布像素对比基准，定义误差阈值；在 M0 决定 layer 存储格式（linear+dither vs srgb）

2. **显存压力 / tile 震荡**
   - 对策：LRU 预算上限 + 可见 tile 优先 + 统计 cache miss；以 allocation probe 结果设预算并留安全余量

3. **Tile 接缝/缩放伪影**
   - 对策：合成/commit 用 `textureLoad`；显示缩放采用 tile padding 或手动 clamp；必要时对缩放路径做专门验收用例

4. **tile 失效条件遗漏**
   - 对策：显式枚举失效条件（可见性/opacity/blend/顺序/内容），并加测试用例

5. **导出/截图大任务导致 GPU 超时/不稳定**
   - 对策：导出按 tile/chunk 分块合成与 readback（例如 2048x2048 chunk），避免长时间单次提交

6. **兼容性**
   - 对策：保留 Canvas2D fallback，GPU 不可用自动切换

## 9. 验收用例（摘要）

- 8K 单层连续长笔画（30s），无停画/报错
- 4K 多特性组合与 Canvas2D 视觉对比
- 多层可见切换时仅重建受影响的 tile

## 10. 默认假设

- 单次仅对 active layer 绘画
- 32GB 显卡 8K，4060 笔记本 4K
- readback 仅用于导出/截图

## 11. 阶段任务清单（可执行）

### Phase 0：基线与风险收敛

- 8K WebGPU 纹理分配/clear/compose micro-benchmark（记录峰值显存与帧耗时）
- 明确 blend modes 目标清单与“视觉一致性”误差阈值
- 定义 `rgba8unorm` 线性存储 + sRGB 显示的转换规则与 dither 方案；并对比 `rgba8unorm-srgb` 存储方案
- 明确 tile size（256/512）与 LRU 预算策略（预算来自 allocation probe）
- 明确 device lost/OOM 的降级顺序与恢复机制

### Phase 1：Tile 显示与最小合成

- 新增 GPU tile 显示层（替换 `LayerRenderer.composite()` 的实时路径）
- 实现 `GpuLayerStore` + `TileResidencyManager`
- 完成 `below/above` 可见 tile 缓存与刷新逻辑
- 验收：多层可见切换时仅重建对应 tile，绘画帧只做可见 tile 合成

### Phase 2：GPU 笔刷直写 + commit

- 改造 `GPUStrokeAccumulator` 输出到 `activeScratch (rgba16float)` tiles
- 实现 `commitStroke()`：`activeScratch + activeLayer -> activeLayerTmp (rgba8unorm)` 并 swap
- 引入抖动（Bayer 4x4 优先）
- 验收：8K 单层连续绘画稳定，无 readback

### Phase 3：特性恢复与一致性回归

- dual / texture / wet-edge / scatter 全路径 GPU 化
- 建立小画布像素对比基准（2K/4K）
- 验收：主要笔刷组合视觉一致，误差可控

### Phase 4：Selection/Mask 与导出

- selection 纹理化并纳入合成
- 明确导出/截图 readback 路径（仅在用户触发时执行）
- 导出按 tile/chunk 分块 readback + CPU 拼接（避免 TDR / GPU process reset）

### Phase 5：优化与可扩展性评估

- 优化 tile cache miss 与合成 pass 数量
- 对热点 shader 做性能优化（合成 pass 合并、减少采样次数）

## 12. M0 基线记录（待补）

> 通过 `window.__gpuM0Baseline()` 获取结果后填写

### 12.1 纹理分配/clear 基线

- 4K `rgba8unorm`：create 0.1ms / clear 4.3ms
- 4K `rgba8unorm-srgb`：create ~0ms / clear 3.4ms
- 8K `rgba8unorm`：create ~0ms / clear 6.8ms
- 8K `rgba8unorm-srgb`：create ~0ms / clear 7.4ms

### 12.2 Allocation Probe（估算浏览器配额）

- 4K `rgba8unorm`：allocated 32 / totalBytes 2,147,483,648 (~2.0 GiB)
- 4K `rgba8unorm-srgb`：allocated 32 / totalBytes 2,147,483,648 (~2.0 GiB)
- 8K `rgba8unorm`：allocated 32 / totalBytes 8,589,934,592 (~8.0 GiB)
- 8K `rgba8unorm-srgb`：allocated 32 / totalBytes 8,589,934,592 (~8.0 GiB)

### 12.3 Tile Size 对比（256/512）

- 4K tile 256（16x16 / 256 tiles / ~64MB 估算显存）
- 4K tile 512（8x8 / 64 tiles / ~64MB 估算显存）

### 12.5 Tile Size 实测对比（4K，GPU 渲染 + LRU 模拟）

**Run A**（canvas=4096, frames=20, budgetRatio=0.25, viewportTiles=4）
- 256：upload **135.6ms** / renderCPU **0.52ms** / renderGPU **3.46ms**  
  LRU miss **12.7%**（hits 4719 / misses 689 / evictions 625）
- 512：upload **31.6ms** / renderCPU **0.155ms** / renderGPU **2.94ms**  
  LRU miss **70.3%**（hits 238 / misses 562 / evictions 546）

**Run B**（canvas=4096, frames=30, budgetRatio=0.20, viewportTiles=5）
- 256：upload **102.7ms** / renderCPU **0.54ms** / renderGPU **3.52ms**  
  LRU miss **26.2%**（hits 5317 / misses 1883 / evictions 1832）
- 512：upload **25.2ms** / renderCPU **0.153ms** / renderGPU **3.23ms**  
  LRU miss **100%**（hits 0 / misses 800 / evictions 788）

**结论（阶段性）**：
- **性能层面**：512 在 upload 与 render CPU/GPU 耗时上明显更低。  
- **LRU 命中**：同预算比例下 256 显著更稳，512 在较小预算/较大视窗时 miss 很高。  
- **M2 决策**：继续采用 **512**（调度/渲染开销更低），同时 **LRU 预算比例不能过低**，后续应结合实际 viewport 与显存预算调整。  

### 12.4 M0 结论（基于当前数据）

- **浏览器配额（Allocation Probe）**：4K 至少 ~2.0 GiB，8K 至少 ~8.0 GiB（均可连续分配 32 张）。  
  **建议**：LRU 预算先取 60%~70% 的保守值，**5.0 GiB** 作为初始上限（后续可调）。
- **格式选择（性能维度）**：`rgba8unorm` 与 `rgba8unorm-srgb` 的 create/clear 成本差异极小，性能不足以成为决定因素。  
  **结论**：格式以视觉一致性（暗部 banding、叠加误差）为准，待视觉对比后锁定。
- **格式选择（视觉对比）**：`linear-no-dither / linear+dither / srgb` 三图对比（1024 生成图案）肉眼无明显差异。  
  **结论**：先锁定 `rgba8unorm (linear + dither)` 作为 layer 存储；`rgba8unorm-srgb` 暂不引入额外复杂度。
- **Tile Size**：256/512 的总显存相近，但 512 调度与 LRU 开销更低。  
  **建议**：M2 阶段先用 **512**，M3 再对比 256 的 cache miss 与帧耗时。

## 13. M2 验收记录模板（补全）

> 目标：统一“自动 + 手动”验收入口，记录通过/阻塞信息，避免口头结论不可复现。

### 13.1 自动检查（每次改动后）

- `pnpm -s check:all`（必须通过；允许既有 warning，不新增 error）
- `window.__gpuM0Baseline()`（确认可执行并写入 residency budget 缓存）
- `window.__gpuTileSizeCompare({...})`（可选，针对预算/viewport 调参）

### 13.2 手动验收场景（M2 最小集）

1. 单层 4K 连续绘制 30s  
   期望：无 WebGPU ValidationError / device lost，输入无明显抖动。
2. 选区绘制（含边缘）  
   期望：仅选区内修改，边缘无越界污染。
3. 撤销/重做  
   期望：dirty tile readback 后历史回滚正确。
4. 多层可见 fallback  
   期望：自动切 Canvas2D，视觉结果正确。

### 13.3 验收结果记录（复制填写）

```md
#### M2 Acceptance Run - YYYY-MM-DD HH:mm

- Build/Checks:
  - `pnpm -s check:all`: PASS/FAIL
- Environment:
  - GPU:
  - Canvas size:
  - Render mode:
- Case 1 (Single-layer 4K 30s): PASS/FAIL
  - Notes:
- Case 2 (Selection bounds/AA): PASS/FAIL
  - Notes:
- Case 3 (Undo/Redo): PASS/FAIL
  - Notes:
- Case 4 (Multi-layer fallback): PASS/FAIL
  - Notes:
- Resource/Performance:
  - Residency budget bytes:
  - Dirty tiles per commit (sample):
- Final:
  - Overall: PASS/FAIL
  - Blockers:
```

### 13.4 验收记录（2026-02-06 Replay/稳定性检查点）

- Build/Checks:
  - `pnpm -s typecheck`: PASS
  - 关键文件 `eslint`: PASS
- Environment:
  - Canvas: `5000x5000`
  - Render mode: GPU（单层）
  - Replay case: `abr/case-5000-04.json`
- Replay:
  - `__strokeCaptureReplay`：PASS（可稳定出图，事件回放成功）
  - 已修复问题：回放阶段 1px 细线（压感被实时流污染）  
- Diagnostics (`window.__gpuBrushDiagnostics()`):
  - 当前绘制链路可运行，`previewReadbackEnabled=false`（符合 M2 预期）
  - 存在启动阶段历史 `GPUValidationError` 记录：
    - `Buffer size (6410240000) exceeds max (536870912)`
    - submit label 涉及 `GPU Startup Init Encoder` / `Prewarm Dual Readback Encoder` / `Dual Blend Encoder`
  - 判断：属于启动/预热路径风险，需在 M2 单层路径下做条件化关闭或按需启用。
- Final:
  - Overall: **PARTIAL PASS**
  - Blockers:
    - 启动期 Dual 预热触发超大 staging buffer 报错，污染稳定性门禁
    - 需补“诊断分代/重置”能力，避免历史错误干扰当前结论

### 13.5 验收记录（2026-02-06 Phase 6A 解阻实现）

- Build/Checks:
  - `pnpm -s typecheck`: PASS
  - `pnpm -s test -- useGlobalExports`: PASS
  - `pnpm -s test -- startupPrewarmPolicy`: PASS
  - `pnpm -s test -- DebugPanel`: PASS
- Changes:
  - `GPUStrokeAccumulator.initializePresentableTextures()` 已加入启动期 Dual 预热条件化跳过：
    - `width * height >= 16_000_000` 或 `device.limits.maxBufferSize <= 536_870_912`
  - 跳过时写入 `startup-dual-prewarm-skipped` 诊断事件（记录尺寸/上限/原因）。
  - 新增 `resetDiagnostics()`，并在快照中暴露 `diagnosticsSessionId` / `resetAtMs`。
  - 新增全局调试接口 `window.__gpuBrushDiagnosticsReset()`，Debug Panel 已接入 `Reset GPU Diag` 按钮（dev/test 可见）。
- Final:
  - Overall: **PARTIAL PASS**
  - Residual risks:
    - 仍需真实环境执行 3 轮 `case-5000-04` 回放并确认当前会话 `uncapturedErrors` 无新增。
    - 仍需手工压感 20 笔短测确认起笔/行笔连续性与无尾 dab。

### 13.6 验收记录（2026-02-06 Phase 6A 收敛实现：大画布分层）

- Build/Checks:
  - `pnpm -s typecheck`: PASS
  - `pnpm -s test -- inputUtils`: PASS
  - `pnpm -s test -- DebugPanel`: PASS
  - `pnpm -s test -- useGlobalExports`: PASS
  - `pnpm -s test -- startupPrewarmPolicy`: PASS
- Changes:
  - DebugPanel 新增完整门禁按钮流：
    - `Run Phase6A Auto Gate`：自动 reset 诊断、每轮 replay 前清层、等待 1 帧、回放 3 轮、输出 PASS/FAIL 报告。
    - `Record 20-Stroke Manual Gate`：强制 checklist + 诊断条件联合判定，避免“有问题但 PASS”。
  - 大画布输入保护（`max(width,height) >= 4096`）：
    - `pointerdown` 压力顺序固定为 `buffered > fresh currentPoint (<=80ms) > PointerEvent > 0.03`。
    - WinTab 路径统一“新鲜度”判断，陈旧 `currentPoint` 不再覆盖事件压力。
  - 诊断统计增强：
    - 新增 `startPressureFallbackCount`，并写入 Auto/Manual Gate 报告。
- Final:
  - Overall: **PARTIAL PASS**
  - Residual risks:
    - 仍需目标硬件下执行真实 `5000x5000` 手工 20 笔复验，确认无起笔细头与偶发丢笔触。
    - 若仍出现问题，进入下一轮“定点修首点时序/队列”而非回退当前门禁框架。

### 13.7 验收记录（2026-02-06 压感策略回退与基线恢复）

- Background:
  - 13.6 的输入保护策略在门禁数字上可通过，但手绘压感出现“珠串/扭曲”回归。
  - 用户反馈并复现：手绘异常、回放正常。
- Decision:
  - 回退输入策略实验，恢复压感基线；保留 DebugPanel 门禁能力与诊断分代能力。
  - 压感问题后续以独立专题处理，不与 6A 其它稳定性项混改。
- Evidence:
  - 用户手测确认：回退后压感恢复可用。
  - 自动检查仍通过：`typecheck`、`DebugPanel`、`useGlobalExports`、`startupPrewarmPolicy`、`inputUtils`。
- Inference:
  - 压感数据捕获链路本身大概率可用，问题更集中在“实时输入应用到笔触”的策略层。
  - 大画布更易触发可能与时序/性能放大有关，但不是充分条件（小画布也可被同策略影响）。
- Final:
  - Overall: **PARTIAL PASS**
  - Next:
    - 继续推进 6A 其余稳定性门禁项
    - 压感优化延后并独立验证（避免污染性能阶段结论）

### 13.8 决议记录（2026-02-06 临时豁免：选项 2）

- Decision:
  - 对 `Phase 6A` 采用临时豁免策略：先推进后续任务，压感细头问题后置专项处理。
- Scope:
  - 允许执行：Phase 6B 性能探索、非压感阻塞项优化、数据采集与链路减负实验。
  - 不允许宣称：M2 稳定性封版通过。
- Guardrail:
  - 6A 状态保持 `PARTIAL PASS`，直到 manual checklist 全项通过。
  - 所有性能结果标记为“预结论/非封版”。
  - 最终发布前必须回到 6A 全量复验并通过。
- Latest signal:
  - Auto Gate：PASS（`case-5000-04.json`，`uncapturedErrors=0`，`deviceLost=NO`，`startPressureFallbackCount=0`）。
  - Manual Gate：第一条“无起笔细头”仍可能不满足。

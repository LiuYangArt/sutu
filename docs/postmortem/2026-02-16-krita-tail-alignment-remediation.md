# Krita 尾端一致性整改文档（2026-02-16）

## 直接结论

你的需求已经足够明确，不是“需求不清”导致的。  
问题在于实现时我把目标错误收敛成了“尾段补偿要像 Krita”，而不是“整条笔划求解链路要像 Krita”。

---

## 1. 为什么会出现偏差（复盘）

### 1.1 目标被错误拆解

我把“Krita 一致”拆成了：

1. `finishStroke()` 要返回 tail dabs  
2. tail dabs 走主渲染链提交  

这两点是必要条件，但不是充分条件。  
Krita 的尖尾核心是**工具层轨迹收敛 + 采样层 + 动态传感器层**同时连续工作，而不是尾端补一段。

### 1.2 当前实现仍是“补偿型 tail 生成器”

当前代码仍是条件触发的 tail 机制，而非 Krita 的主链路收敛：

- `evaluateTailTaper()` 触发/拦截：`src/utils/strokeBuffer.ts:1532`
- `buildTailDabs()` 人工构造收尾：`src/utils/strokeBuffer.ts:1642`
- 末点强制 `pressure: 0`：`src/utils/strokeBuffer.ts:1708`
- `finishStroke()` 以 tail 生成器为入口：`src/utils/strokeBuffer.ts:1955`

### 1.3 验收口径偏“代码行为”，缺少“视觉同构”

这轮测试主要证明了“有 tail 提交且幂等”，但没有把下面这些作为强制门槛：

1. 与 Krita 同输入序列的末段几何趋势一致
2. 与 Krita 同参数下的末端宽度/透明度曲线一致
3. 不出现“补丁感”而必须是主链连续

---

## 2. 当前实现与 Krita 的本质差异

1. 当前是 tail 条件触发；Krita 是轨迹收敛后自然采样。  
2. 当前末点强制归零；Krita 无“强制 pressure=0 补丁”。  
3. 当前 `fadeProgress` 固定为 `0`，动态传感器不完整：`src/components/Canvas/useBrushRenderer.ts:609`。  
4. 当前采样以距离阈值为主；Krita 是 distance + timing 联合采样。  
5. 当前尾段使用“最后一次笔态”复用；Krita 收尾是逐样本时序推进（尤其 stabilizer）。

---

## 3. Krita 一致目标（重新定义）

“Krita 一致”在工程上定义为：

1. **无尾端外推补丁**：不再存在独立 tail 生成器。  
2. **统一事件求解**：收笔时继续消费真实输入轨迹与平滑队列，输出真实末段。  
3. **统一采样器**：主段与末段共享同一 spacing/timing 采样器。  
4. **统一动态链**：pressure/size/opacity/flow/shape/scatter/color 在末段无分叉。  
5. **同口径验收**：以 Krita A/B 对照图和统计指标为准。

---

## 4. Implementation Plan（中文）

### Phase A（P0）移除“补偿型 tail”架构

目标：先消除结构性偏差。

1. `BrushStamper.finishStroke()` 去 tail 生成职责，只做状态收束。  
2. 删除 `evaluateTailTaper()` / `buildTailDabs()` 这类独立尾段求解逻辑。  
3. 保留调试快照，但语义改为“收笔收束状态”，不再是“是否触发 tail 特效”。

涉及文件：

- `src/utils/strokeBuffer.ts`
- `src/utils/__tests__/brushStamper.speedTail.test.ts`
- `src/utils/__tests__/brushStamper.tailDebug.test.ts`

### Phase B（P0）补齐 Krita 风格“轨迹收敛层”

目标：把收笔收敛放到输入/平滑层，而不是 tail 注入层。

1. 新增 `KritaLikeFreehandSmoother`（建议独立模块），维护 `older/previous/tangent`。  
2. 抬笔时执行最后段贝塞尔收敛（对齐 Krita `finishStroke()` 思路）。  
3. 稳定器模式下实现“队列收束”语义（对齐 `addFinishingEvent()` 的作用域）。

建议新增文件：

- `src/utils/freehand/kritaLikeFreehandSmoother.ts`
- `src/utils/freehand/__tests__/kritaLikeFreehandSmoother.test.ts`

改造接入：

- `src/components/Canvas/useBrushRenderer.ts`

### Phase C（P0）采样器升级为 distance + timing 联合

目标：末段采样时序与 Krita 更接近。

1. 在 stamper/segment sampler 中新增 timed spacing 累积器。  
2. 每次求下一个 dab 时取 distance/time 更早触发者。  
3. 主段与收尾段走同一个 `getNextPointPosition` 风格 API。

涉及文件（建议）：

- `src/utils/strokeBuffer.ts`（或抽 `segmentSampler.ts`）
- `src/utils/__tests__/brushStamper.*.test.ts`

### Phase D（P1）动态传感器链补全

目标：末段参数不再“看起来是贴上去的”。

1. `DynamicsInput.fadeProgress` 不再固定 `0`，改为真实 stroke progress。  
2. 增加 distance/time 进度输入（或统一 `strokeMetrics`）供 transfer/shape 使用。  
3. 保证末段与主段共享同一 pressure LUT + pressure curve + transfer 计算顺序。

涉及文件：

- `src/components/Canvas/useBrushRenderer.ts`
- `src/types/brush.ts`（若需扩展 `DynamicsInput`）
- `src/brush/*` 相关 dynamics 计算模块

### Phase E（P1）验收升级为 Krita A/B 对照

目标：防止“代码通过但手感不一致”再发生。

1. 固定输入回放（同坐标/压感/时间戳）并导出 PNG。  
2. 对比指标：末段宽度曲线、alpha 曲线、末端角度连续性。  
3. 加入手测用例：慢抬笔、快甩笔、急停、连笔急停。

---

## 5. Task List（中文）

1. 重构 `src/utils/strokeBuffer.ts`：删除 tail 触发与构造逻辑，改为“无补丁收束”。  
2. 新增 `KritaLikeFreehandSmoother`：实现 `processPoint()` + `finishStrokeSegment()`。  
3. 在 `useBrushRenderer` 接入 smoother 输出，不再从 `finishStroke()`拿 tail dabs。  
4. 实现 distance+timing 联合采样器，并替换现有距离阈值单通道采样。  
5. 扩展 `DynamicsInput` 进度字段，打通 transfer/shape/color 的末段输入一致性。  
6. 重写测试口径：从“是否注入 tail”转为“收敛段连续性 + 对照一致性”。  
7. 更新文档：`docs/postmortem/soft-brush-and-stroke-taper.md` 与本文同步。

---

## 6. 新的验收标准（DoD）

### 自动化（必须全过）

1. 收笔无独立 tail 注入路径（静态检查 + 单测）。  
2. 末段 dabs 全部位于真实最后段（几何约束）。  
3. 无“末点强制 pressure=0”硬编码路径。  
4. 同输入回放下，末段宽度/alpha 曲线与基线误差在阈值内。

### 手测（必须执行）

1. 统一笔刷参数，在 Sutu 与 Krita 各画三组：慢抬、快甩、急停。  
2. 观察尾端：不能出现“贴尾巴”感，末段过渡连续。  
3. 快甩场景下应自然尖尾；慢抬场景不应过度加工。  
4. GPU/CPU 路径观感一致，不允许一端尖、一端钝。

---

## 7. 风险与边界

1. 这是结构改造，不是小修，短期会影响现有 tail 相关测试。  
2. 若不先做 Phase A/B，继续调阈值只会反复回归“补丁感”。  
3. 本轮默认先对齐主笔划；Dual Brush 次级笔尖尾端可放在下一轮对齐。

---

## 8. 执行顺序建议

1. 先做 Phase A + B（去补丁、上收敛层）。  
2. 再做 Phase C（采样器升级）。  
3. 最后做 Phase D + E（动态补全与 A/B 验收封口）。

这是最快达到“Krita 观感一致”且可持续维护的路径。


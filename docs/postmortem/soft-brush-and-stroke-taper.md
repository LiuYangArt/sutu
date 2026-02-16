# 软笔刷硬度与笔触尾端处理经验

## 问题概述

在实现 M3.2 笔刷引擎扩展时，遇到两个相关问题：

1. **软笔刷边缘裁切**：Hardness=0% 时，笔触在结束后出现硬边裁切
2. **笔触尾端无渐变**：快速抬笔时笔触末端是钝的，缺少自然的尖尾

## 问题一：软笔刷边缘裁切

### 现象

设置 Hardness=0%（软笔刷）时，笔触在 `endStroke` 后出现明显的硬边裁切，好像被一条直线切断。

### 根因分析

**关键发现**：软笔刷使用高斯衰减，渲染范围延伸到标称半径的 1.5 倍。

```typescript
// stampDab 中的软笔刷处理
const maxExtent = 1.5; // 软笔刷处理区域延伸到 1.5x 标称半径
if (normDist > maxExtent) {
  continue;
}
```

但 `expandDirtyRect` 只使用了 `maxRadius`（标称半径），导致：
1. 软笔刷渲染区域 = 1.5x 半径
2. Dirty rect 记录区域 = 1.0x 半径
3. 部分渲染内容在 dirty rect 之外，被裁切

### 修复方案

**文件**: `src/utils/strokeBuffer.ts`

```typescript
// 修复前
const maxRadius = Math.max(radiusX, radiusY);
this.expandDirtyRect(x, y, maxRadius);

// 修复后：软笔刷延伸到 1.5x，加 AA 边距
const extentMultiplier = hardness >= 0.99 ? 1.0 : 1.5;
const effectiveRadius = maxRadius * extentMultiplier + 1; // +1 for AA margin
this.expandDirtyRect(x, y, effectiveRadius);
```

同时更新 bounding box 计算：

```typescript
// 使用 effectiveRadius 计算像素操作区域
const left = Math.max(0, Math.floor(x - effectiveRadius));
const top = Math.max(0, Math.floor(y - effectiveRadius));
const right = Math.min(this.width, Math.ceil(x + effectiveRadius));
const bottom = Math.min(this.height, Math.ceil(y + effectiveRadius));
```

### 教训

**Dirty rect 必须覆盖实际渲染区域**。当渲染算法有特殊扩展（如高斯衰减、抗锯齿边距）时，dirty rect 计算也必须同步更新。

---

## 问题二：笔触尾端无渐变

### 现象

- 慢速画笔：有自然的尖尾（硬件压感渐降）
- 快速画笔：末端是钝的，没有渐变

### 调查过程

#### 假设 1：添加人工渐变 dabs

**方案**：在 `finishStroke` 中沿笔触方向添加渐变 dabs，压感递减。

```typescript
// 尝试的代码（已回滚）
finishStroke(brushSize: number): Array<...> {
  const fadeoutDabs = [];
  const fadeoutDistance = brushSize * 0.5;
  const fadeoutSteps = 5;

  for (let i = 1; i <= fadeoutSteps; i++) {
    const t = i / fadeoutSteps;
    fadeoutDabs.push({
      x: this.lastPoint.x + direction.x * fadeoutDistance * t,
      y: this.lastPoint.y + direction.y * fadeoutDistance * t,
      pressure: this.lastPoint.pressure * (1 - t),
    });
  }
  return fadeoutDabs;
}
```

**结果**：❌ 失败。产生"剧烈的变尖"效果，渐变 dabs 与主笔触脱节，非常不自然。

#### 假设 2：参考 Krita 源码

分析了 Krita 的动态传感器实现：

| 文件 | 机制 |
|------|------|
| `KisDynamicSensorFade.cpp` | 基于 dab 序号的渐变 |
| `KisDynamicSensorDistance.cpp` | 基于笔触总长度的渐变 |
| `KisDynamicSensorSpeed.cpp` | 基于绘画速度的动态调整 |

**关键发现**：Krita 的笔触尖尾来自**可选的 Fade/Speed 传感器**，需要在笔刷预设中明确配置。默认情况下，Krita 笔刷也没有自动尖尾。

#### 假设 3：基于速度的压感衰减

**方案**：检测笔移动速度，高速时降低压感。

```typescript
// 尝试的代码（已回滚）
private calculateSpeedTaper(speed: number): number {
  const speedThreshold = 800; // pixels/second
  if (speed > speedThreshold) {
    const excess = speed - speedThreshold;
    const taperFactor = Math.max(0.3, 1 - excess / 1500);
    return taperFactor;
  }
  return 1.0;
}
```

**结果**：❌ 失败。速度影响整个笔触，不只是尾部。产生"乱七八糟"的效果——笔触中间随机变细变粗。

### 最终决策

**接受现状**：快速笔触末端是钝的。

**理由**：
1. 自然的尖尾来自硬件压感渐降，需要用户配合控制
2. 人工渐变容易造成不自然的视觉效果
3. Krita/Photoshop 的尖尾也依赖于特定笔刷预设，不是默认行为
4. 速度检测影响整个笔触，副作用太大

### 教训

1. **不要过度工程化**：自然的手感来自硬件和用户技巧，强行用软件补偿往往适得其反
2. **参考专业软件的实际行为**：Krita 源码分析表明，专业软件的特效也是可选配置，不是默认魔法
3. **速度检测需要慎重**：速度影响整个笔触的动态，不适合只用于尾部处理

---

## 相关代码：EMA 压感平滑

在调试过程中，确认了 EMA（指数移动平均）压感平滑的正确实现：

**文件**: `src/utils/strokeBuffer.ts` (BrushStamper)

```typescript
// 压感平滑参数
private static readonly PRESSURE_SMOOTHING = 0.35;  // 0-1, 越低越平滑

private smoothPressure(rawPressure: number): number {
  if (this.smoothedPressure === 0) {
    this.smoothedPressure = rawPressure;  // 首次直接使用
  } else {
    // EMA: smoothed = α * raw + (1-α) * previous
    this.smoothedPressure =
      PRESSURE_SMOOTHING * rawPressure +
      (1 - PRESSURE_SMOOTHING) * this.smoothedPressure;
  }
  return this.smoothedPressure;
}
```

**关键点**：
- EMA 只在笔移动后才开始应用（避免静止时压感累积）
- 配合延迟启动机制（MIN_MOVEMENT_DISTANCE = 3px）

---

## 总结

| 问题 | 根因 | 解决方案 |
|------|------|----------|
| 软笔刷边缘裁切 | Dirty rect 未覆盖 1.5x 扩展区域 | 使用 effectiveRadius |
| 笔触尾端无渐变 | 硬件压感在快速抬笔时来不及渐降 | 接受现状，不做人工补偿 |

## 相关文件

| 文件 | 职责 |
|------|------|
| `src/utils/strokeBuffer.ts` | StrokeAccumulator (dab 渲染)、BrushStamper (点位生成) |
| `src/components/Canvas/useBrushRenderer.ts` | 笔刷渲染管线 |
| `src/components/Canvas/index.tsx` | 画布事件处理 |

---

## 2026-02-16 补充复盘：#146 计划执行偏差与阻塞优先级

### 背景

本轮 #146 明确要求两件关键事同时成立：

1. Tail taper 在实际绘制链路中稳定生效（含 WinTab）
2. Tablet 压感曲线编辑器复用 CurvesPanel 的成熟交互内核，而不是再写一套

用户实测反馈显示两点都未达到预期，说明“实现了功能片段”但“没有完成计划定义的收敛目标”。

### 偏差点（事实）

1. **曲线编辑器复用目标未达成**
   - 计划要求：从 `CurvesPanel` 抽离纯交互编辑层并复用。
   - 实际：`SettingsPanel` 使用独立的 `PressureCurveEditor` 实现，行为与 `CurvesPanel` 有细节漂移。
   - 影响：加点/删点/拖拽手感不一致，维护成本翻倍，后续修复需要双处改动。

2. **Tail taper 在 GPU 主路径存在生效缺口**
   - tail 注入逻辑位于 `useBrushRenderer.endStroke()`。
   - 但 GPU 收笔主路径通过 `commitStrokeGpu()` 提交，未统一经过上述 tail 注入流程。
   - 影响：CPU/GPU 行为不一致，用户在主路径下容易感知“尾端还是钝的”。

3. **tail 压感映射链路与主笔划不完全一致**
   - 主笔划点使用全局 pressure LUT + 笔刷 pressure curve。
   - tail 点未完全复用同一压感映射链路。
   - 影响：尾端手感和主笔划存在割裂，尖尾稳定性与可预测性下降。

### 根因

1. **架构收敛不彻底**：新增能力挂在局部函数上，而非收敛到“唯一收笔路径”。
2. **复用决策落地不彻底**：未先抽象交互内核，直接在设置页重写编辑器，导致行为分叉。
3. **验收口径偏实现导向**：检查了“有代码/有测试”，但没有把“GPU 主路径与用户体感”作为强制验收门槛。

### 经验教训（新增）

1. 对“手感类功能”，**必须以主链路真实行为验收**，不能只看单元测试通过。
2. 对“已存在成熟交互”的需求，**优先抽象复用，再接业务**，避免平行实现。
3. 计划里写了“决策已定”后，执行阶段应有 **逐条勾选的完成定义（DoD）**，防止局部完成被误判为计划完成。

### 后续怎么办：按阻塞优先级排序

#### P0（当前阻塞，先做）

1. **收敛收笔路径（GPU/CPU 同源）**
   - 目标：无论 GPU 还是 CPU，都经过同一套 tail 判定与注入流程。
   - 验收：同一输入序列下，GPU/CPU 的 tail 触发率与末端宽度趋势一致。

2. **修正 tail 压感映射链路**
   - 目标：tail dab 使用与主笔划完全一致的 pressure 映射顺序（含全局 LUT）。
   - 验收：tail 与主笔划过渡连续，不出现“尾端突变粗细/透明度”。

3. **补充运行时可观测性（只用于调试）**
   - 目标：可查看当前速度、归一化速度、tail 触发原因（被哪条条件拦截）。
   - 验收：WinTab 复测时可快速定位“为什么没触发”。

#### P1（高优先，解除交互维护阻塞）

1. **抽离并复用 CurvesPanel 交互内核**
   - 目标：`PressureCurveEditor` 不再维护独立交互逻辑，统一复用单通道曲线编辑核心。
   - 验收：加点/删点/拖拽/Delete 删除/拖出删除的行为与 CurvesPanel 一致。

2. **旧设置曲线点迁移与压缩**
   - 目标：对历史“高密点阵”做一次性压缩（保持形状近似），默认不再出现难以操作的大量点。
   - 验收：迁移后可编辑性显著提升，曲线形状误差在可接受阈值内。

#### P2（收尾与防回归）

1. **补充 feature 回归测试（GPU 主路径必测）**
   - 包括：tail 触发/不触发、曲线编辑交互一致性、WinTab 场景回放。
2. **更新 #146 完成标准**
   - 增加“主链路手感验收”与“复用完成证明（无平行交互实现）”。

### 下一轮执行原则

1. 先修 P0，再动 P1。  
2. 每完成一项都用同一组 WinTab 手工动作回归：慢速轻压、快速连笔、快速甩笔。  
3. 只有当用户实测“尾端稳定变尖 + 曲线编辑不别扭”后，才视为 #146 真正完成。  

### 2026-02-16 实施结果（本次代码落地）

本次已按 “P0 -> P1” 连续落地，关键点如下：

1. **GPU/CPU 收笔路径同源化已完成**
   - `prepareStrokeEndGpu()` 与 `endStroke()` 统一走 `finalizeStrokeTailOnce(trigger)`。
   - 每个 stroke 只允许一次 tail finalize（幂等锁），避免重复注入。

2. **tail 压感映射链路已统一**
   - 进入 stamper 前统一走 global pressure LUT。
   - 主 dab 与 tail dab 统一走 `stamper pressure -> brush pressure curve` 映射。

3. **tail 调试可观测性已接入**
   - `BrushStamper` 新增 `TailTaperDebugSnapshot` 与 `TailTaperBlockReason`。
   - `useBrushRenderer` 暴露 `getTailTaperDebugSnapshot()`。
   - `Canvas` 全局新增 `window.__brushTailTaperDebug?.()`。

4. **曲线交互内核复用已完成**
   - 新增 `src/components/CurveEditor/singleChannelCore.ts`。
   - 新增 `src/components/CurveEditor/useSingleChannelCurveEditor.ts`。
   - `PressureCurveEditor` 改为薄封装，`CurvesPanel` 切换到同一交互内核。

5. **历史高密曲线迁移压缩已接入**
   - `src/utils/pressureCurve.ts` 新增 `compressPressureCurvePoints()`。
   - settings 加载阶段对历史高密点执行压缩与误差阈值回退。

6. **回归测试已补齐**
   - 新增：
     - `src/components/Canvas/__tests__/useBrushRenderer.strokeEnd.test.ts`
     - `src/utils/__tests__/brushStamper.tailDebug.test.ts`
   - 扩展：
     - `src/components/CurvesPanel/__tests__/CurvesPanel.test.tsx`
     - `src/components/SettingsPanel/__tests__/PressureCurveEditor.test.tsx`
     - `src/stores/__tests__/settings.test.ts`

## 2026-02-16 收官补记：Krita 对齐最后一段的真实差异

这轮实测里，视觉上“已经接近”但体感仍不自然，最终差异主要在三个点：

1. **收尾虽然连续，但收敛方式不对**
   - 旧实现本质仍偏“tail 注入思路”，容易出现短三角感或段间过渡发硬。
   - 最终改为更接近 Krita 的收敛路径：沿 finish segment 做连续采样并提交，避免把收尾当作孤立补丁。

2. **压力衰减曲线过于线性**
   - 线性衰减会让尾端“几何上变细了，但观感仍突兀”。
   - 改为平滑衰减（Hermite/ease-out 形态）后，尾端宽度与透明度过渡更连贯，尖端不再突兀。

3. **起笔阶段方向未稳定时就放大了压力影响**
   - 首样本方向噪声会被直接放大，导致起笔局部抖动。
   - 增加起笔锚点与早期抗抖处理后，首端形态明显稳定，首尾对称性更接近 Krita。

### 这次最关键的经验

1. **“连续”不等于“自然”**
   - 从离散点变为连续段，只是第一步；是否沿主笔划收敛路径退火，才决定最终体感。

2. **不能把收尾当独立特效**
   - 一旦收尾链路在 pressure 映射、spacing、提交时序上与主链路分叉，就会出现“看起来像贴上去的尾巴”。

3. **调试可观测性必须常驻**
   - `window.__brushTailTaperDebug?.()` 能快速区分“阈值未触发”与“几何段缺失”等问题，否则会反复误判为算法参数问题。

## 2026-02-16 收尾补充：压感入口语义统一与回归门槛

### 语义澄清（防止再次歧义）

1. **工具栏 Pressure 开关是强制 Override 入口**
   - 设计意图：即使 Brush Settings 内未开启 pressure control，工具栏开关也可以强制启用 pressure 驱动。

2. **内部计算必须走同一条动态链路**
   - 已收敛为 `effective dynamics`：
     - size：统一走 Shape Dynamics 路径（工具栏 `P(size)` 强制覆盖为 `sizeControl=penPressure`）。
     - flow/opacity：统一走 Transfer 路径（工具栏 `P(flow/opacity)` 强制覆盖为 `flowControl/opacityControl=penPressure`）。
   - 主笔划与 tail 使用同一套 effective 配置，避免“主段和收尾两套语义”。

3. **工具栏开关只做“强制开启”，不做“强制关闭”**
   - `P=ON`：强制 pressure 生效。
   - `P=OFF`：不覆盖 Brush Settings，若笔刷内已配置 pressure control 仍照常生效。

### 新增自动化回归（本轮补齐）

1. `src/components/Canvas/__tests__/useBrushRenderer.strokeEnd.test.ts`
   - 覆盖：Shape Dynamics 非 pressure 控制时，工具栏 `P(size)` 仍可强制接管并影响主笔划/尾段。

2. `src/components/Canvas/__tests__/useBrushRendererOpacity.test.ts`
   - 覆盖：Transfer 非 pressure 控制时，工具栏 `P(flow)` 仍可强制接管并生效。

3. `src/utils/__tests__/brushStamper.speedTail.test.ts`
   - 覆盖：
     - 起笔锚点抗抖（首段不被离群点拉偏）；
     - 尾段首点压力与主段末点的连续交接；
     - 小笔刷尾段 spacing 下限（防止回退为离散点串）。

### 结论

本轮后，#146 的“压感一致性”不再仅靠主观手感判断，已经由语义约束 + 关键回归用例共同锁定。

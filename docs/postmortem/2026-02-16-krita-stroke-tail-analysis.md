# Krita 笔触尾端机制源码分析（2026-02-16）

## 目标

解释一个核心问题：**Krita 的尖尾是怎么来的**，以及为什么它不是“在最后补一串 tail 点”的效果。

本分析只基于 Krita 源码事实，不做主观猜测。

---

## 结论先行

1. **Krita 没有在收笔时做“越过末点的外推补尾”**。  
2. Krita 的收尾来自三层共同作用：  
   - 工具层：轨迹收敛（Bezier/稳定器队列收敛）  
   - 采样层：沿真实 segment 的 spacing/timing 连续采样  
   - 动态层：同一 `KisPaintInformation` 驱动 size/opacity/flow 等参数  
3. **尖尾是主链路自然收敛结果**，不是孤立后处理特效。

---

## 一、工具层：收尾做的是“轨迹收敛”，不是“几何外推”

### 1) `endPaint()` 的收尾入口

- 文件：`F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:681`
- 行为：
  - 如果笔触几乎没画：补一次 `paintAt(previous)`
  - 否则当 smoothing 非 `NO_SMOOTHING` 时调用 `finishStroke()`
  - 如果 smoothing 为 `STABILIZER`，继续走 `stabilizerEnd()`

### 2) `finishStroke()` 只闭合最后一个真实段

- 文件：`F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:929`
- 关键调用：`paintBezierSegment(olderPaintInformation, previousPaintInformation, ...)`
- 事实：
  - 只使用已有的 `older -> previous` 两个真实点
  - 不生成“lastPoint 之后”的外推终点
  - 没有“强制 pressure=0 的尾端补丁”逻辑

### 3) Stabilizer 收尾是“清队列”，不是“外推尾巴”

- 文件：`F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:892`
- `stabilizerEnd()` 在 `finishStabilizedCurve=true` 时：
  - 先 `stabilizerPollAndPaint()` 消化已有事件
  - 再 `addFinishingEvent(queue.size())` 后再 poll 一次
- 文件：`F:\CodeProjects\krita\libs\ui\tool\kis_stabilized_events_sampler.cpp:56`
  - `addFinishingEvent()` 只是把 `lastPaintInformation` 放回事件采样器，并加一个 `elapsedTimeOverride`
  - 目的是把稳定器内部延迟队列“收完”，不是额外扩展几何轨迹

---

## 二、采样层：只在真实段内插值采样（t 在 [0,1]）

### 1) paintLine 主循环

- 文件：`F:\CodeProjects\krita\libs\image\brushengine\kis_paintop_utils.h:54`
- 主循环：
  - `while ((t = currentDistance->getNextPointPosition(...)) >= 0.0)`
  - `pi = KisPaintInformation::mix(t, pi, pi2)`
  - `pi.paintAt(op, currentDistance)`

这意味着 dab 点是从 `pi1 -> pi2` 连续插值出来的，不是额外独立尾点。

### 2) `getNextPointPosition()` 的边界

- 文件：`F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:405`
- 事实：
  - 未达到 spacing/timing：返回 `-1`
  - 达到条件：返回 `t`，几何和时间分支都只给出段内比例
  - 例如 isotropic 分支 `t = nextPointDistance / dragVecLength`（`<=1`）
  - timed 分支 `t = nextPointInterval / (endTime - startTime)`（`<=1`）

因此尾端 dab 仍在最后真实 segment 内，不会越界外推。

---

## 三、动态层：尖尾由同一参数链自然收敛

### 1) BrushOp 的 `paintAt()` 使用同一 `info`

- 文件：`F:\CodeProjects\krita\plugins\paintops\defaultpaintops\brush\kis_brushop.cpp:103`
- 同一 `KisPaintInformation info` 驱动：
  - `m_sizeOption.apply(info)`
  - `m_rotationOption.apply(info)`
  - `m_scatterOption.apply(info, ...)`
  - `m_opacityOption.apply(info, &dabOpacity, &dabFlow)`
  - softness / lightness 等

结论：尾端不会走“特殊简化链路”，和主笔划是同一条渲染链。

### 2) 传感器系统是统一入口

- 文件：`F:\CodeProjects\krita\plugins\paintops\libpaintop\KisCurveOption.cpp:29`
- `generateSensors()` 会把 Pressure/Speed/Fade/Distance/Time 等装配进同一 option 计算。

关键传感器实现：

- `Fade`：`currentDabSeqNo / length`  
  文件：`F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensorFade.cpp:21`
- `Distance`：`totalStrokeLength / length`  
  文件：`F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensorDistance.cpp:21`
- `Speed`：`info.drawingSpeed()`  
  文件：`F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensors.h:19`

再由 `KisDynamicSensor::parameter()` 做曲线映射后参与 option 合成。  
文件：`F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensor.cpp:35`

---

## 四、默认平滑配置对尾端观感的影响

- 文件：`F:\CodeProjects\krita\libs\ui\kis_config.cc:2156`
  - `lineSmoothingType` 默认值 `1`（`SIMPLE_SMOOTHING`）
- 文件：`F:\CodeProjects\krita\libs\ui\tool\kis_smoothing_options.h:20`
  - 枚举：`NO / SIMPLE / WEIGHTED / STABILIZER / PIXEL_PERFECT`
- 文件：`F:\CodeProjects\krita\libs\ui\kis_config.cc:2246`
  - `lineSmoothingFinishStabilizedCurve` 默认 `true`
- 文件：`F:\CodeProjects\krita\libs\ui\kis_config.cc:2196`
  - `lineSmoothingTailAggressiveness` 默认 `0.15`（主要作用于 `WEIGHTED_SMOOTHING`）

补充：`WEIGHTED_SMOOTHING` 内部确实有 `tailAggressiveness` 参与权重计算。  
文件：`F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:545`

---

## 五、对“尖尾”成因的工程化解释

尖尾通常来自下面组合，而不是单独某一行“尾端补点”代码：

1. 最后真实段通过 smoothing/stabilizer 被平滑收敛。  
2. 该段内部仍按 spacing/timing 连续出 dab。  
3. 最后几枚 dab 的 size/opacity/flow 继续受 pressure/fade/distance/speed 曲线共同控制。  
4. 因为几何和参数都在同链路连续变化，视觉上形成自然尖尾。

---

## 六、对齐时必须遵守的 Krita 约束（提炼）

1. **禁止末端外推**：尾端采样点必须位于最后真实 segment 内。  
2. **禁止孤立补丁链路**：收尾点必须复用主笔划同一 option/sensor/render 提交流程。  
3. **收尾属于轨迹收敛，不是特效注入**：先保证输入轨迹与采样连续，再谈尾端观感。  
4. **速度不是唯一触发器**：Krita 中 speed 是一个可配置传感器，不是“尾端是否生成”的硬开关。

---

## 七、仍需注意的边界

1. 不同笔刷预设（是否启用 pressure/fade/distance/speed 传感器）会显著改变尾端形态。  
2. 相同源码机制下，若预设参数不同，也可能观察到“并不尖”的尾端。  
3. 因此“对齐 Krita”必须同时对齐：  
   - 输入平滑模式  
   - 采样策略  
   - 传感器曲线与笔刷预设参数


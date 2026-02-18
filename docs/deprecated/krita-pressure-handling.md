# Krita 压感处理机制分析（修订版）

> 状态：**已合并入主文档，不再持续维护**。  
> 请优先阅读：`docs/research/2026-02-18-krita-wacom-pressure-full-chain.md`  
> 一页图速览：`docs/research/2026-02-18-krita-wacom-pressure-one-page.md`

本文档基于当前本地 Krita 源码快照（`F:\CodeProjects\krita`）整理压感相关链路，作为 PaintBoard 对齐参考。

- 修订日期：2026-02-17
- 重点：修正旧版文档中的过时链路和语义误读
- 范围：压感/速度/采样链路；不展开 Tool Options 的轨迹平滑实现

---

## 目录

1. [结论速览](#1-结论速览)
2. [当前真实链路（运行时）](#2-当前真实链路运行时)
3. [压感曲线系统（KisCubicCurve）](#3-压感曲线系统kiscubiccurve)
4. [速度平滑器（KisSpeedSmoother）](#4-速度平滑器kisspeedsmoother)
5. [压感信息构建器（KisPaintingInformationBuilder）](#5-压感信息构建器kispaintinginformationbuilder)
6. [增量平均（KisIncrementalAverage）现状](#6-增量平均kisincrementalaverage现状)
7. [过滤滚动平均（KisFilteredRollingMean）](#7-过滤滚动平均kisfilteredrollingmean)
8. [本次修正点清单](#8-本次修正点清单)
9. [对 PaintBoard 的应用建议](#9-对-paintboard-的应用建议)

---

## 1. 结论速览

1. 当前 Krita 压感主链路是：`KoPointerEvent -> KisPaintingInformationBuilder -> KisPaintInformation -> paintLine 采样插值 -> 传感器消费`。
2. `KisIncrementalAverage` 目前不是运行时主链路组件（当前快照中仅见定义与单测引用）。
3. 全局压感曲线由 `KisCubicCurve` 预采样 LUT + `interpolateLinear()` 查询实现。
4. 速度估计由 `KisSpeedSmoother` + `KisFilteredRollingMean` 完成，第一个点速度固定为 `0`。
5. `KisPaintingInformationBuilder::reset()` 只清理速度平滑器状态，不是“清空所有历史状态”。
6. `DisablePressure` 命名与分支语义存在反直觉点，对齐时应以实际 `KisPaintInformation` 输出为准。

---

## 2. 当前真实链路（运行时）

```text
Tablet/Mouse/Touch (Qt)
    -> KoPointerEvent
    -> KisToolFreehandHelper::startStroke/continueStroke
    -> KisPaintingInformationBuilder::createPaintingInformation
         - pressureToCurve (global curve)
         - KisSpeedSmoother::getNextSpeed
    -> KisPaintInformation
    -> KisPaintOpUtils::paintLine (采样插值 + paintAt)
    -> Dynamic Sensors (Pressure/Speed/...) 消费
```

关键锚点（当前快照）：

- Builder 入口：`libs/ui/tool/kis_tool_freehand_helper.cpp:259`、`libs/ui/tool/kis_tool_freehand_helper.cpp:464`
- 构建 `KisPaintInformation`：`libs/ui/tool/kis_painting_information_builder.cpp:121`
- 压感曲线查询：`libs/ui/tool/kis_painting_information_builder.cpp:179`
- 采样插值/发射：`libs/image/brushengine/kis_paintop_utils.h:67`

---

## 3. 压感曲线系统（KisCubicCurve）

### 源码位置

- `libs/image/kis_cubic_curve.h`
- `libs/image/kis_cubic_curve.cpp`
- `libs/image/kis_cubic_curve_spline.h`

### 核心机制

1. 默认曲线是 `(0,0) -> (1,1)`。
2. 配置字符串可解析点列表（含 `is_corner` 标记）。
3. 运行时通常先生成 transfer LUT，再线性插值查询。

### 关键锚点

- 默认曲线初始化：`libs/image/kis_cubic_curve.cpp:158`
- 曲线字符串解析：`libs/image/kis_cubic_curve.cpp:190`
- `value()`（边界裁剪 + spline）：`libs/image/kis_cubic_curve.cpp:125`
- transfer 预计算：`libs/image/kis_cubic_curve.cpp:137`
- 线性查询：`libs/image/kis_cubic_curve.cpp:400`
- `floatTransfer()`：`libs/image/kis_cubic_curve.cpp:468`

### 备注

`interpolateLinear()` 最后使用 `copysign` 返回带符号值（`libs/image/kis_cubic_curve.cpp:425`），因此对齐时应直接复刻该函数行为，不要只写“无符号线性插值”。

---

## 4. 速度平滑器（KisSpeedSmoother）

### 源码位置

- `libs/ui/tool/kis_speed_smoother.h`
- `libs/ui/tool/kis_speed_smoother.cpp`

### 关键常量与参数

- `MAX_SMOOTH_HISTORY = 512`：`libs/ui/tool/kis_speed_smoother.cpp:17`
- `NUM_SMOOTHING_SAMPLES = 3`：`libs/ui/tool/kis_speed_smoother.cpp:19`
- `MIN_TRACKING_DISTANCE = 5`：`libs/ui/tool/kis_speed_smoother.cpp:20`

### 核心逻辑

1. 第一个点：返回速度 `0`（`libs/ui/tool/kis_speed_smoother.cpp:111`）。
2. 时间差：写入 `KisFilteredRollingMean` 并取 `filteredMean()`（`libs/ui/tool/kis_speed_smoother.cpp:120`）。
3. 距离累计：在历史 buffer 反向遍历，达到样本数和最小距离阈值后计算速度。
4. 输出：`lastSpeed = totalDistance / totalTime`（满足阈值条件时）。

### clear() 的真实语义

`clear()` 会重置 timer、distance buffer、lastPoint、lastSpeed（`libs/ui/tool/kis_speed_smoother.cpp:90`），但不会显式清空 `timeDiffsMean`。

---

## 5. 压感信息构建器（KisPaintingInformationBuilder）

### 源码位置

- `libs/ui/tool/kis_painting_information_builder.h`
- `libs/ui/tool/kis_painting_information_builder.cpp`

### 关键点

1. 压感分辨率常量：`LEVEL_OF_PRESSURE_RESOLUTION = 1024`（`libs/ui/tool/kis_painting_information_builder.cpp:26`）。
2. 配置刷新时会生成 `1025` 个压感采样点：`curve.floatTransfer(LEVEL_OF_PRESSURE_RESOLUTION + 1)`（`libs/ui/tool/kis_painting_information_builder.cpp:48`）。
3. `startStroke()` 记录起点并进入 `createPaintingInformation()`（`libs/ui/tool/kis_painting_information_builder.cpp:61`）。
4. `pressureToCurve()` 通过 `KisCubicCurve::interpolateLinear()` 执行映射（`libs/ui/tool/kis_painting_information_builder.cpp:179`）。
5. `reset()` 仅调用 `m_speedSmoother->clear()`（`libs/ui/tool/kis_painting_information_builder.cpp:184`）。

### `DisablePressure` 语义提醒

`createPaintingInformation()` 中 pressure 分支在当前代码为：

- `!m_pressureDisabled ? 1.0 : pressureToCurve(event->pressure())`
- 位置：`libs/ui/tool/kis_painting_information_builder.cpp:131`

该命名与行为组合有反直觉风险；做对齐和验证时，建议以最终 `KisPaintInformation` 的实际 pressure 值为准，而不是只依据变量名推断。

---

## 6. 增量平均（KisIncrementalAverage）现状

### 源码位置

- `libs/ui/input/wintab/kis_incremental_average.h`

### 当前状态（重要）

在当前本地快照中，`KisIncrementalAverage` 未检索到运行时调用点，主要存在于：

- 类定义：`libs/ui/input/wintab/kis_incremental_average.h:14`
- 单测：`libs/ui/tests/kis_input_manager_test.cpp:370`

因此不应再把它描述为“当前 WinTab 压感主链路首站”。

### 代码事实

1. 首次 `pushThrough()` 会用首值填满窗口（避免首帧突变）。
2. 增量更新复杂度 O(1)。
3. 当前实现把初始和写成 `m_sum = 3 * value`（`libs/ui/input/wintab/kis_incremental_average.h:31`），不是 `m_size * value`。

---

## 7. 过滤滚动平均（KisFilteredRollingMean）

### 源码位置

- `libs/global/KisFilteredRollingMean.h`
- `libs/global/KisFilteredRollingMean.cpp`

### 核心机制

1. `addValue()` 维护滚动和，复杂度 O(1)（`libs/global/KisFilteredRollingMean.cpp:24`）。
2. `filteredMean()` 会按 `effectivePortion` 去掉两端极值后求均值（`libs/global/KisFilteredRollingMean.cpp:34`）。
3. `KisSpeedSmoother` 默认构造为 `window=200, effectivePortion=0.8`（`libs/ui/tool/kis_speed_smoother.cpp:29`）。

---

## 8. 本次修正点清单

1. 修正主链路图：移除“`KisIncrementalAverage` 是运行时首站”的说法。
2. 修正 `KisIncrementalAverage` 初始和描述：`3 * value`（与当前源码一致）。
3. 修正 `reset()` 描述：从“清空所有历史状态”改为“仅清理速度平滑器状态”。
4. 补充 `DisablePressure` 的命名/分支反直觉风险，避免误读。
5. 保留并核实 `KisCubicCurve`、`KisSpeedSmoother`、`KisFilteredRollingMean` 的有效结论与锚点。

---

## 9. 对 PaintBoard 的应用建议

### P0（立即执行）

1. 复刻 `KisCubicCurve` 的 LUT + `interpolateLinear()` 语义（含边界裁剪与线性查询细节）。
2. 速度链路按 `KisSpeedSmoother` 对齐：首点为 0、最小跟踪距离阈值、过滤时间均值。
3. 对齐验证脚本中，把 pressure/speed 的“实际输出值”作为判定基准，不依赖变量命名。

### P1（后续增强）

1. 采样阶段对齐 `paintLine + mix` 语义，重点关注 pressure/time/speed 的插值一致性。
2. 若后续要覆盖旧 WinTab 兼容路径，再单独评估是否需要引入 `KisIncrementalAverage` 式首值填充策略。

---

## 参考文件

- `libs/image/kis_cubic_curve.h`
- `libs/image/kis_cubic_curve.cpp`
- `libs/ui/tool/kis_speed_smoother.h`
- `libs/ui/tool/kis_speed_smoother.cpp`
- `libs/ui/tool/kis_painting_information_builder.h`
- `libs/ui/tool/kis_painting_information_builder.cpp`
- `libs/ui/input/wintab/kis_incremental_average.h`
- `libs/global/KisFilteredRollingMean.h`
- `libs/global/KisFilteredRollingMean.cpp`

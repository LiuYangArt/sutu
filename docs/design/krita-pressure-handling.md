# Krita 压感处理机制分析

本文档整理 Krita 的 WinTab 压感处理完整机制，作为 PaintBoard 压感优化的参考。

> **Krita 源码位置**: `F:\CodeProjects\krita`

---

## 目录

1. [架构概览](#架构概览)
2. [压感曲线系统 (KisCubicCurve)](#1-压感曲线系统-kiscubiccurve)
3. [速度平滑器 (KisSpeedSmoother)](#2-速度平滑器-kisspeedsmoother)
4. [压感信息构建器 (KisPaintingInformationBuilder)](#3-压感信息构建器-kispaintinginformationbuilder)
5. [增量平均 (KisIncrementalAverage)](#4-增量平均-kisincrementalaverage)
6. [过滤滚动平均 (KisFilteredRollingMean)](#5-过滤滚动平均-kisfilteredrollingmean)
7. [关键设计模式](#关键设计模式)
8. [PaintBoard 应用建议](#paintboard-应用建议)

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Krita 压感处理流水线                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  WinTab API                                                     │
│      │                                                          │
│      ▼                                                          │
│  ┌──────────────────────┐                                       │
│  │ KisIncrementalAverage │  ← 原始压感平滑（滑动窗口）           │
│  └──────────────────────┘                                       │
│      │                                                          │
│      ▼                                                          │
│  ┌──────────────────────────────────┐                           │
│  │ KisPaintingInformationBuilder    │                           │
│  │  ├─ pressureToCurve()            │  ← 压感曲线映射            │
│  │  ├─ KisSpeedSmoother             │  ← 速度计算与平滑          │
│  │  └─ KisFilteredRollingMean       │  ← 时间差过滤平均          │
│  └──────────────────────────────────┘                           │
│      │                                                          │
│      ▼                                                          │
│  ┌──────────────────────┐                                       │
│  │ KisPaintInformation  │  ← 最终绘图信息                        │
│  └──────────────────────┘                                       │
│      │                                                          │
│      ▼                                                          │
│  Brush Engine → Canvas                                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. 压感曲线系统 (KisCubicCurve)

### 源码位置

- **头文件**: `libs/image/kis_cubic_curve.h`
- **实现**: `libs/image/kis_cubic_curve.cpp`
- **样条算法**: `libs/image/kis_cubic_curve_spline.h`

### 核心功能

用户可自定义压感映射曲线，通过控制点定义输入压感到输出压感的非线性映射。

### 关键代码引用

| 功能 | 文件:行号 | 说明 |
|------|-----------|------|
| 默认曲线 | `kis_cubic_curve.cpp:158-164` | 默认 (0,0) 到 (1,1) 线性曲线 |
| 曲线字符串解析 | `kis_cubic_curve.cpp:190-246` | 格式: `"0.0,0.0;1.0,1.0;"` |
| 预计算查找表 | `kis_cubic_curve.cpp:136-152` | `updateTransfer()` 生成采样表 |
| 值计算 | `kis_cubic_curve.cpp:125-134` | `value()` 使用样条插值 |
| 线性插值查找 | `kis_cubic_curve.h:108` | `interpolateLinear()` 静态方法 |

### 默认曲线初始化

```cpp
// kis_cubic_curve.cpp:158-164
KisCubicCurve::KisCubicCurve()
    : d(new Private)
{
    d->data = new Data;
    d->data->points.append({ 0.0, 0.0, false });  // 起点
    d->data->points.append({ 1.0, 1.0, false });  // 终点
}
```

### 曲线值计算

```cpp
// kis_cubic_curve.cpp:125-134
qreal KisCubicCurve::Data::value(qreal x)
{
    updateSpline();
    // 自动扩展曲线边界外的部分，并限制 y 值范围
    x = qBound(points.first().x(), x, points.last().x());
    qreal y = spline.getValue(x);
    return qBound(qreal(0.0), y, qreal(1.0));
}
```

### 预计算查找表生成

```cpp
// kis_cubic_curve.cpp:136-152
template<typename _T_, typename _T2_>
void KisCubicCurve::Data::updateTransfer(QVector<_T_>* transfer,
                                          bool& valid,
                                          _T2_ min, _T2_ max, int size)
{
    if (!valid || transfer->size() != size) {
        if (transfer->size() != size) {
            transfer->resize(size);
        }
        qreal end = 1.0 / (size - 1);
        for (int i = 0; i < size; ++i) {
            _T2_ val = value(i * end) * max;
            val = qBound(min, val, max);
            (*transfer)[i] = val;
        }
        valid = true;
    }
}
```

### 快速线性插值查找

```cpp
// kis_cubic_curve.h:108
static qreal interpolateLinear(qreal normalizedValue, const QVector<qreal> &transfer);
```

**用法**:
```cpp
// kis_painting_information_builder.cpp:179-182
qreal KisPaintingInformationBuilder::pressureToCurve(qreal pressure)
{
    return KisCubicCurve::interpolateLinear(pressure, m_pressureSamples);
}
```

---

## 2. 速度平滑器 (KisSpeedSmoother)

### 源码位置

- **头文件**: `libs/ui/tool/kis_speed_smoother.h`
- **实现**: `libs/ui/tool/kis_speed_smoother.cpp`

### 核心功能

计算笔触移动速度，并通过历史数据平滑速度值，用于速度感知笔刷效果。

### 关键代码引用

| 功能 | 文件:行号 | 说明 |
|------|-----------|------|
| **第一点处理** | `kis_speed_smoother.cpp:111-116` | 第一个点返回速度 0（关键！） |
| 距离计算 | `kis_speed_smoother.cpp:109` | `kisDistance(pt, m_d->lastPoint)` |
| 时间差平滑 | `kis_speed_smoother.cpp:120-121` | 使用 KisFilteredRollingMean |
| 最小距离阈值 | `kis_speed_smoother.cpp:20,150,156` | MIN_TRACKING_DISTANCE = 5 像素 |
| 清空历史 | `kis_speed_smoother.cpp:90-97` | `clear()` 方法 |

### 常量定义

```cpp
// kis_speed_smoother.cpp:17-20
#define MAX_SMOOTH_HISTORY 512
#define NUM_SMOOTHING_SAMPLES 3
#define MIN_TRACKING_DISTANCE 5
```

### 第一点特殊处理（关键！）

```cpp
// kis_speed_smoother.cpp:107-116
qreal KisSpeedSmoother::getNextSpeedImpl(const QPointF &pt, qreal time)
{
    const qreal dist = kisDistance(pt, m_d->lastPoint);

    if (m_d->lastPoint.isNull()) {
        m_d->lastPoint = pt;
        m_d->lastTime = time;
        m_d->lastSpeed = 0.0;  // 关键：第一个点速度为 0
        return 0.0;
    }
    // ...
}
```

### 速度计算逻辑

```cpp
// kis_speed_smoother.cpp:128-160
m_d->distances.push_back(Private::DistancePoint(dist, time));

Private::DistanceBuffer::const_reverse_iterator it = m_d->distances.rbegin();
Private::DistanceBuffer::const_reverse_iterator end = m_d->distances.rend();

qreal totalDistance = 0;
qreal totalTime = 0.0;
int itemsSearched = 0;

for (; it != end; ++it) {
    itemsSearched++;
    totalDistance += it->distance;

    // 使用过滤后的平均时间差，而非原始时间戳
    // 因为数位板时间戳不可靠
    totalTime += avgTimeDiff;

    if (itemsSearched > m_d->numSmoothingSamples &&
        totalDistance > MIN_TRACKING_DISTANCE) {
        break;
    }
}

if (totalTime > 0 && totalDistance > MIN_TRACKING_DISTANCE) {
    m_d->lastSpeed = totalDistance / totalTime;
}
```

### 重置方法

```cpp
// kis_speed_smoother.cpp:90-97
void KisSpeedSmoother::clear()
{
    m_d->timer.restart();
    m_d->distances.clear();
    m_d->distances.push_back(Private::DistancePoint(0.0, 0.0));
    m_d->lastPoint = QPointF();
    m_d->lastSpeed = 0.0;
}
```

---

## 3. 压感信息构建器 (KisPaintingInformationBuilder)

### 源码位置

- **头文件**: `libs/ui/tool/kis_painting_information_builder.h`
- **实现**: `libs/ui/tool/kis_painting_information_builder.cpp`

### 核心功能

将原始输入事件转换为 `KisPaintInformation` 对象，包含压感曲线映射和速度计算。

### 关键代码引用

| 功能 | 文件:行号 | 说明 |
|------|-----------|------|
| 压感分辨率 | `kis_painting_information_builder.cpp:26` | LEVEL_OF_PRESSURE_RESOLUTION = 1024 |
| 压感曲线加载 | `kis_painting_information_builder.cpp:47-48` | 从配置读取曲线，生成 1025 个采样点 |
| **笔触开始** | `kis_painting_information_builder.cpp:61-72` | `startStroke()` 记录起点 |
| 压感映射 | `kis_painting_information_builder.cpp:179-182` | `pressureToCurve()` 使用线性插值 |
| **重置速度平滑器** | `kis_painting_information_builder.cpp:184-187` | `reset()` 调用 `m_speedSmoother->clear()` |

### 压感分辨率

```cpp
// kis_painting_information_builder.cpp:26
const int KisPaintingInformationBuilder::LEVEL_OF_PRESSURE_RESOLUTION = 1024;
```

### 压感曲线加载

```cpp
// kis_painting_information_builder.cpp:44-49
void KisPaintingInformationBuilder::updateSettings()
{
    KisConfig cfg(true);
    const KisCubicCurve curve(cfg.pressureTabletCurve());
    m_pressureSamples = curve.floatTransfer(LEVEL_OF_PRESSURE_RESOLUTION + 1);
    // ...
}
```

### 笔触开始

```cpp
// kis_painting_information_builder.cpp:61-72
KisPaintInformation KisPaintingInformationBuilder::startStroke(
    KoPointerEvent *event,
    int timeElapsed,
    const KoCanvasResourceProvider *manager)
{
    if (manager) {
        m_pressureDisabled = manager->resource(KoCanvasResource::DisablePressure).toBool();
    }

    m_startPoint = event->point;
    return createPaintingInformation(event, timeElapsed);
}
```

### 压感曲线映射

```cpp
// kis_painting_information_builder.cpp:179-182
qreal KisPaintingInformationBuilder::pressureToCurve(qreal pressure)
{
    return KisCubicCurve::interpolateLinear(pressure, m_pressureSamples);
}
```

### 重置方法

```cpp
// kis_painting_information_builder.cpp:184-187
void KisPaintingInformationBuilder::reset()
{
    m_speedSmoother->clear();
}
```

---

## 4. 增量平均 (KisIncrementalAverage)

### 源码位置

- **头文件**: `libs/ui/input/wintab/kis_incremental_average.h`

### 核心功能

对 WinTab 原始输入进行滑动窗口平均，**关键特性是第一个值用于初始化整个缓冲区**。

### 关键代码引用

| 功能 | 文件:行号 | 说明 |
|------|-----------|------|
| **第一值初始化** | `kis_incremental_average.h:26-33` | 用第一个值填充整个缓冲区（关键！） |
| 滑动窗口平均 | `kis_incremental_average.h:35-44` | O(1) 复杂度的增量计算 |

### 完整实现

```cpp
// kis_incremental_average.h:14-52
class KisIncrementalAverage
{
public:
    KisIncrementalAverage(int size)
        : m_size(size),
          m_index(-1),      // -1 表示未初始化
          m_sum(0),
          m_values(size)
    {
    }

    inline int pushThrough(int value) {
        if (m_index < 0) {
            // 关键：第一个值用于初始化整个缓冲区
            for (int i = 0; i < m_size; i++) {
                m_values[i] = value;
            }
            m_index = 0;
            m_sum = m_size * value;  // 默认 m_size = 3
            return value;
        }

        // 滑动窗口：替换最老的值
        int oldValue = m_values[m_index];
        m_values[m_index] = value;

        m_sum += value - oldValue;

        if (++m_index >= m_size) {
            m_index = 0;
        }

        return m_sum / m_size;
    }

private:
    int m_size;
    int m_index;
    int m_sum;
    QVector<int> m_values;
};
```

### 设计要点

1. **第一值初始化**: 避免第一笔压感突变
2. **O(1) 复杂度**: 增量计算，无需遍历缓冲区
3. **环形缓冲区**: 使用 `m_index` 循环索引

---

## 5. 过滤滚动平均 (KisFilteredRollingMean)

### 源码位置

- **头文件**: `libs/global/KisFilteredRollingMean.h`
- **实现**: `libs/global/KisFilteredRollingMean.cpp`

### 核心功能

计算滚动平均值，但**过滤掉极端偏差值**。用于估计数位板采样率。

### 关键代码引用

| 功能 | 文件:行号 | 说明 |
|------|-----------|------|
| 构造 | `KisFilteredRollingMean.cpp:16-22` | 窗口大小 + 有效比例 |
| 添加值 | `KisFilteredRollingMean.cpp:24-32` | O(1) 复杂度 |
| 过滤平均 | `KisFilteredRollingMean.cpp:34-85` | 排序后去掉极端值再计算平均 |

### 构造函数

```cpp
// KisFilteredRollingMean.cpp:16-22
KisFilteredRollingMean::KisFilteredRollingMean(int windowSize, qreal effectivePortion)
    : m_values(windowSize),
      m_rollingSum(0.0),
      m_effectivePortion(effectivePortion),
      m_cutOffBuffer(qCeil(0.5 * (qCeil(windowSize * (1.0 - effectivePortion)))))
{
}
```

**默认使用**: 窗口大小 200，有效比例 0.8（即去掉 20% 的极端值）

### 添加值（O(1)）

```cpp
// KisFilteredRollingMean.cpp:24-32
void KisFilteredRollingMean::addValue(qreal value)
{
    if (m_values.full()) {
        m_rollingSum -= m_values.front();
    }

    m_values.push_back(value);
    m_rollingSum += value;
}
```

### 过滤平均计算

```cpp
// KisFilteredRollingMean.cpp:34-85
qreal KisFilteredRollingMean::filteredMean() const
{
    KIS_SAFE_ASSERT_RECOVER_RETURN_VALUE(!m_values.empty(), 0.0);

    const int usefulElements = qMax(1, qRound(m_effectivePortion * m_values.size()));
    const int cutOffTotal = m_values.size() - usefulElements;

    if (cutOffTotal > 0) {
        const std::vector<double>::size_type cutMin = qRound(0.5 * cutOffTotal);
        const std::vector<double>::size_type cutMax = cutOffTotal - cutMin;

        sum = m_rollingSum;
        num = usefulElements;

        // 部分排序找到最小的 cutMin 个值
        std::partial_sort_copy(m_values.begin(), m_values.end(),
                               m_cutOffBuffer.begin(),
                               m_cutOffBuffer.begin() + cutMin);

        // 减去最小值
        sum -= std::accumulate(m_cutOffBuffer.begin(),
                               m_cutOffBuffer.begin() + cutMin, 0.0);

        // 部分排序找到最大的 cutMax 个值
        std::partial_sort_copy(m_values.begin(), m_values.end(),
                               m_cutOffBuffer.begin(),
                               m_cutOffBuffer.begin() + cutMax,
                               std::greater<qreal>());

        // 减去最大值
        sum -= std::accumulate(m_cutOffBuffer.begin(),
                               m_cutOffBuffer.begin() + cutMax, 0.0);
    }

    return sum / num;
}
```

---

## 关键设计模式

### 1. 第一笔问题的解决

Krita 通过两个机制避免第一笔压感异常：

1. **KisIncrementalAverage**: 用第一个压感值填充整个缓冲区
2. **KisSpeedSmoother**: 第一个点速度返回 0

### 2. 预计算查找表

压感曲线使用预计算的 1025 个采样点查找表，运行时只需线性插值，复杂度 O(1)。

### 3. 过滤极端值

KisFilteredRollingMean 在计算平均值时排除极端偏差，提高鲁棒性。

### 4. 笔触生命周期管理

- `startStroke()`: 记录起点，可选禁用压感
- `continueStroke()`: 后续点的处理
- `reset()`: 清空所有历史状态

---

## PaintBoard 应用建议

### 短期（解决第一笔问题）

1. **实现 PressureSmoother**
   - 模仿 `KisIncrementalAverage` 的第一值初始化逻辑
   - 滑动窗口大小默认 3

2. **集成到 InputProcessor**
   - 在 `process()` 中应用压感平滑
   - 在 `reset()` 中清空平滑器状态

### 中期（增强功能）

1. **添加配置选项**
   - 平滑窗口大小可配置
   - 平滑功能可开关

2. **实现速度计算**
   - 参考 `KisSpeedSmoother`
   - 用于速度感知笔刷

### 长期（完整实现）

1. **自定义压感曲线**
   - 参考 `KisCubicCurve`
   - UI 曲线编辑器

2. **过滤滚动平均**
   - 参考 `KisFilteredRollingMean`
   - 提高时间计算鲁棒性

---

## 参考文件清单

| 文件路径 | 说明 |
|----------|------|
| `libs/image/kis_cubic_curve.h` | 压感曲线头文件 |
| `libs/image/kis_cubic_curve.cpp` | 压感曲线实现 |
| `libs/image/kis_cubic_curve_spline.h` | 样条算法 |
| `libs/ui/tool/kis_speed_smoother.h` | 速度平滑器头文件 |
| `libs/ui/tool/kis_speed_smoother.cpp` | 速度平滑器实现 |
| `libs/ui/tool/kis_painting_information_builder.h` | 压感信息构建器头文件 |
| `libs/ui/tool/kis_painting_information_builder.cpp` | 压感信息构建器实现 |
| `libs/ui/input/wintab/kis_incremental_average.h` | 增量平均（仅头文件） |
| `libs/global/KisFilteredRollingMean.h` | 过滤滚动平均头文件 |
| `libs/global/KisFilteredRollingMean.cpp` | 过滤滚动平均实现 |
| `libs/image/brushengine/kis_paint_information.h` | 绘图信息结构 |

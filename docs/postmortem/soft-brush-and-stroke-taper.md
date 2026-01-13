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

# 第一笔压感问题修复经验

## 问题现象

使用 WinTab 数位板绘画时，笔触起点出现"大头"（blob），即使轻轻落笔也会画出很重的第一笔。

![问题示意](../../assets/first-stroke-blob-issue.png)

## 根因分析过程

### 第一轮假设：WinTab 发送了异常高压感

**假设**：WinTab 在笔触开始时发送了异常高的压感值。

**验证方法**：添加 CSV 日志记录完整笔触数据。

**结论**：❌ 错误。日志显示 WinTab 发送的原始压感从 0.01 开始，逐渐增加，并无异常。

```csv
sample,x,y,raw_pressure,smoothed
1,18378,1286,0.0181,0.0000
2,18378,1286,0.0778,0.0000
3,18378,1286,0.1090,0.0273
```

### 第二轮假设：压感平滑逻辑有问题

**假设**：后端的 `PressureSmoother` 没有正确抑制第一笔。

**验证方法**：检查平滑逻辑，确认前两个样本返回 0。

**结论**：❌ 部分正确。后端逻辑正确，但压力 **没有传递到前端**。

### 第三轮：发现真正的根因

**关键发现**：`inputUtils.ts` 中的 `getEffectiveInputData` 函数跳过了 `pressure=0` 的点！

```typescript
// 问题代码
if (pt.pressure > 0) {  // ← 跳过 pressure=0！
  return { pressure: pt.pressure, ... };
}
```

**后果**：
1. 后端返回 `pressure=0`（静默期）
2. 前端跳过这些点，使用上一个有压感的点
3. 后端辛苦做的静默期被完全忽略

### 第四轮：发现第二个问题

**日志显示**：笔在落下后，在同一位置停留了 11 个采样点（55ms），期间压感不断累积。

```csv
sample 1-11: 位置 (21064, 5017) - 同一位置，压感从 0 增到 0.25
sample 12:   位置 (21061, 4916) - 笔终于移动
```

**问题**：`BrushStamper` 在笔静止时不断更新 `lastPoint.pressure`，当笔移动时第一个 dab 使用了累积的高压感。

## 修复方案

### 1. 前端：接受 pressure=0 的点

**文件**: `src/components/Canvas/inputUtils.ts`

```typescript
// 修复后：接受所有压感值
if (pt.timestamp_ms <= eventTime + toleranceMs) {
  return {
    pressure: pt.pressure,  // 包括 0
    tiltX: pt.tilt_x,
    tiltY: pt.tilt_y,
  };
}
```

### 2. 前端：延迟启动机制

**文件**: `src/utils/strokeBuffer.ts` (BrushStamper)

- 等待笔移动至少 3 像素才开始发射 dab
- 静止期间不更新 `lastPoint.pressure`
- 防止压感在原地累积

```typescript
if (!this.hasMovedEnough) {
  if (distFromStart < MIN_MOVEMENT_DISTANCE) {
    // 只更新位置，不更新压感
    this.lastPoint.x = x;
    this.lastPoint.y = y;
    return [];  // 不发射 dab
  }
  // 移动够了才发射第一个 dab
  this.hasMovedEnough = true;
  dabs.push({ x, y, pressure });
}
```

### 3. 前端：移除重复的渐进逻辑

**文件**: `src/components/Canvas/useBrushRenderer.ts`

移除了前端的 `applyPressureFadeIn` 函数，因为后端已经处理了压感渐进。

### 4. 后端：压感平滑

**文件**: `src-tauri/src/input/processor.rs`

- 前 2 个样本返回 0（静默期）
- 样本 3-5 渐进放大 (0.25x, 0.5x, 0.75x)
- 样本 6+ 完整压感
- 滑动窗口平均（窗口大小 3）

## 教训总结

### 1. 日志驱动调试

没有日志就是瞎猜。CSV 日志让我们能清晰看到整条数据链路的每一步。

### 2. 全链路思维

问题不一定在你认为的地方。这次问题出在**前端跳过了后端处理的结果**。

### 3. 坐标系差异

后端日志记录的是 WinTab 坐标（数位板坐标系），前端使用的是 PointerEvent 坐标（屏幕坐标系）。两者不能直接比较。

### 4. 多层防御可能冲突

后端和前端都做了压感渐进，但因为前端跳过了 pressure=0，导致两个系统无法协同。最终决定：**后端负责平滑，前端负责延迟启动**。

## 相关文件

| 文件 | 职责 |
|------|------|
| `src-tauri/src/input/processor.rs` | 后端压感平滑 (PressureSmoother) |
| `src-tauri/src/commands.rs` | 事件处理、压感应用 |
| `src/components/Canvas/inputUtils.ts` | 前端压感数据获取 |
| `src/utils/strokeBuffer.ts` | BrushStamper 延迟启动 |
| `src/components/Canvas/useBrushRenderer.ts` | 笔刷渲染管线 |

## 测试验证

1. 使用 Wacom 数位板轻轻落笔
2. 笔触起点应该是细的，逐渐变粗
3. 不应出现"大头"现象

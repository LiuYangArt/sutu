# GPU Wet Edge 实现 Postmortem

**日期**: 2026-01-22
**状态**: 已解决
**影响**: GPU 笔刷渲染

---

## 问题概述

在 GPU WebGPU Compute Shader 中实现 Wet Edge（湿边）效果时，遇到了两个关键问题：

1. **GPU 笔刷完全无法绘制** - Buffer size 超限错误
2. **首次启用 Wet Edge 时卡顿** - 懒加载在热路径上触发

---

## 问题 1: Buffer Size 超限

### 症状

切换到 GPU 渲染后端后，笔刷完全无法绘制，控制台报错：

```
Buffer size (530841600) exceeds the max buffer size limit (268435456)
- While calling [Queue].Submit([[CommandBuffer from CommandEncoder "Brush Batch Encoder"]])
```

### 根本原因

**不是 Wet Edge 代码的 bug**，而是 GPU 设备初始化时的 `maxBufferSize` 限制太小：

| 项目 | 值 |
|------|-----|
| 需要的 buffer | ~506 MB（取决于画布尺寸） |
| 原限制 | 256 MB (`context.ts:80`) |
| 适配器支持 | 最高 2 GB |

当画布尺寸较大时，`copyTextureToBuffer` 操作需要的 staging buffer 超出了 256 MB 限制。

### 解决方案

修改 `src/gpu/context.ts` 第 78-81 行：

```typescript
// 修改前
requiredLimits: {
  maxBufferSize: 256 * 1024 * 1024,  // 256 MB - 太小
},

// 修改后
requiredLimits: {
  maxBufferSize: Math.min(512 * 1024 * 1024, adapter.limits.maxBufferSize),
},
```

### 经验教训

- WebGPU 的默认 buffer 限制（256 MB）对于大画布不够用
- 错误信息中明确说明了适配器支持的更高限制，应仔细阅读
- 在添加新功能前，应验证现有基础设施是否满足需求

---

## 问题 2: 首次启用 Wet Edge 时卡顿

### 症状

第一次启用 Wet Edge 时，第一笔落笔会有明显卡顿。

### 根本原因

**Display Texture 的懒加载发生在绘制热路径上**：

```
落笔 → flushBatch() → wetEdgePipeline.dispatch() → pingPongBuffer.display
                                                           ↓
                              首次访问触发 ensureDisplayTexture()
                                           ↓
                              创建大纹理（4-32MB）+ 新 BindGroup → 卡顿
```

懒加载虽然节省了不使用 Wet Edge 时的 VRAM，但在首次使用时会造成延迟。

### 解决方案

在 `beginStroke()` 时预热 Display Texture，将资源创建从绘制热路径移到笔划开始时：

```typescript
// GPUStrokeAccumulator.ts - beginStroke()

// Sync wet edge settings from store
this.syncWetEdgeSettings();

// Pre-warm display texture if wet edge is enabled
// This moves the lazy initialization cost from the first flushBatch to beginStroke
if (this.wetEdgeEnabled) {
  this.pingPongBuffer.ensureDisplayTexture();
}
```

### 经验教训

- 懒加载需要考虑"在哪里懒加载"
- 用户按下笔的瞬间是可接受的延迟点（用户心理预期有短暂响应时间）
- 绘制过程中的延迟是不可接受的（破坏流畅体验）

---

## 核心架构设计：非幂等性问题

### 问题

Wet Edge 是非线性的色调映射 `Alpha_new = f(Alpha_old)`。如果在每次 `flushBatch` 后原地修改累积 buffer，会导致：

- 第 1 批 Dabs 绘制 → Wet Edge 修改 Alpha
- 第 2 批 Dabs 继续绘制 → **再次** Wet Edge → `Alpha = f(f(Alpha))`
- 笔画前半段会越来越细/黑，颜色崩坏

### 解决方案

采用**双 Buffer 分离**架构：

1. **Raw Buffer** (ping-pong): 存储原始线性 Alpha，供后续 Dabs 累积
2. **Display Buffer** (独立): Wet Edge 输出目标，仅用于预览

```
数据流:
flushBatch → computeBrush.wgsl → Raw Buffer (swap)
                                      ↓
             computeWetEdge.wgsl → Display Buffer (不 swap)
                                      ↓
             updatePreview ← getPresentableTexture()
```

**关键**: Wet Edge 是 "Read-Only Display Filter"，不修改 Raw Buffer。

---

## 实现的文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/gpu/resources/PingPongBuffer.ts` | 修改 | 新增 `displayTexture` 懒加载 |
| `src/gpu/shaders/computeWetEdge.wgsl` | 新建 | Wet Edge Compute Shader |
| `src/gpu/pipeline/ComputeWetEdgePipeline.ts` | 新建 | Pipeline 封装类 |
| `src/gpu/GPUStrokeAccumulator.ts` | 修改 | 集成 wet edge pipeline |
| `src/gpu/context.ts` | 修改 | 提高 maxBufferSize 限制 |

---

## 算法参数（与 CPU 完全一致）

```wgsl
let center_opacity = 0.65;  // 中心保留 65% 不透明度
let max_boost = 1.8;        // 软边笔刷最大边缘增强
let min_boost = 1.4;        // 硬边笔刷最小边缘增强
// hardness > 0.7 时渐变过渡
// 软边应用 gamma 1.3，硬边跳过以保留 AA
```

---

## 关键经验总结

1. **非幂等操作必须使用独立 buffer** - 后处理效果不能原地修改累积数据
2. **懒加载位置很重要** - 热路径上的懒加载会造成用户可感知的延迟
3. **仔细阅读错误信息** - WebGPU 错误通常包含解决方案提示
4. **预热策略** - 在用户心理预期有延迟的时机（如按下笔）进行资源创建
5. **GPU 设备限制需要显式请求** - 默认限制可能不够用

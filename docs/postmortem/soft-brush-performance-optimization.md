# 软笔刷性能优化经验

## 问题概述

大尺寸软笔刷（150px+）绘制时出现严重卡顿，WebView Manager 单核 CPU 占满。对比 Krita 1000px 软笔刷流畅运行，差距明显。

## 优化历程

### 阶段一：erf LUT + 持久化缓冲区

**问题**：每个 dab 都调用 `ctx.getImageData()` 和 `ctx.putImageData()`，开销巨大。

**方案**：
1. 预计算 erf 查找表（LUT），避免实时计算 Gaussian erf
2. 使用持久化 ImageData 缓冲区，整个笔触期间保持在内存中

**效果**：略有改善，150px+ 仍然卡顿

**提交**：`bdd8922`

### 阶段二：Krita 风格 Mask 缓存

**关键洞察**：分析 Krita 源码发现 `KisDabCache` 模式——笔刷 mask 只在参数变化时重新计算，而非每个 dab 都计算。

**根因**：每个 dab 都重新计算 mask（200px 笔刷 ≈ 31K 像素 × 50 ops = 1.5M ops/dab）

**方案**：
1. 创建 `MaskCache` 类，预计算并缓存 mask
2. 参数变化容差（size 2%、hardness 1%）提升缓存命中率
3. 每 2 个 dab 同步一次 canvas（减少 putImageData 频率）

**效果**：明显改善，200px+ 仍有瓶颈

**提交**：`b15dbf7`

### 阶段三：深度循环优化

**瓶颈分析**：

```typescript
// 每像素 12 次 Math 函数调用（极慢！）
buffer[idx] = Math.round(Math.min(255, Math.max(0, outR)));
buffer[idx + 1] = Math.round(Math.min(255, Math.max(0, outG)));
buffer[idx + 2] = Math.round(Math.min(255, Math.max(0, outB)));
buffer[idx + 3] = Math.round(Math.min(255, Math.max(0, outA * 255)));
```

**计算量**：500px 笔刷 ≈ 196K 像素 × 50 ops = 9.8M ops/dab，200Hz 输入 = 3.9B ops/sec

**优化方案**：

1. **消除 Math.round/min/max**：利用 Uint8ClampedArray 自动 clamp
   ```typescript
   // 优化后：+0.5 实现四舍五入，自动 clamp
   buffer[idx] = outR + 0.5;
   ```

2. **增加 sync 间隔**：从 2 增加到 4

3. **复用 ImageData**：避免每次 sync 分配新内存

4. **硬笔刷快速路径**：hardness >= 99% 跳过 mask 缓存，直接计算圆形

**效果**：性能可用

**提交**：`0c6d0b7`

### 阶段四：代码简化

**问题**：stampToBuffer 和 stampHardBrush 有 15 行完全重复的混合逻辑

**方案**：提取 `blendPixel()` 私有方法

**提交**：`dbe0d06`

## 关键经验

### 1. 第一性原理分析

不要盲目优化，先分析瓶颈：
- 用 Windows 任务管理器确认 CPU 占用
- 计算每秒操作量：像素数 × 每像素操作 × 频率
- 对比成熟软件（Krita）的实现方式

### 2. Krita 源码是宝贵资源

Krita 的 `libs/image/kis_brush.cpp` 和 `libs/brush/KisDabCache.cpp` 展示了成熟的 mask 缓存策略。

### 3. Uint8ClampedArray 的自动 clamp

```typescript
// 慢：12 次函数调用
buffer[idx] = Math.round(Math.min(255, Math.max(0, value)));

// 快：自动 clamp，+0.5 实现四舍五入
buffer[idx] = value + 0.5;
```

### 4. Canvas API 开销

`putImageData()` 是同步阻塞操作，减少调用频率比优化单次调用更重要。

### 5. 缓存策略的参数容差

精确匹配会导致频繁缓存失效。对于连续变化的参数（size、hardness），使用容差可以大幅提升命中率：
- size: 2% 容差
- hardness: 1% 容差
- angle: 0.5° 容差

## 文件变更

| 文件 | 变更 |
|------|------|
| `src/utils/maskCache.ts` | 新增 MaskCache 类，blendPixel 方法 |
| `src/utils/strokeBuffer.ts` | 集成 MaskCache，硬笔刷快速路径，sync 优化 |

## 后续优化方向

1. **Web Worker**：将像素操作移到 Worker 线程
2. **WebGPU Compute Shader**：GPU 并行处理（需检查 Tauri WebView 支持）
3. **更智能的 sync 策略**：基于 dirty rect 大小动态调整 sync 间隔

# GPU Roundness 实现 - InstanceBuffer.push() 遗漏字段

## 事件概述

| 项目 | 内容 |
|------|------|
| 日期 | 2026-01-23 |
| 问题 | GPU compute shader 圆头笔刷 roundness 参数无效，画出的圆形被"方形裁剪" |
| 根因 | `InstanceBuffer.push()` 遗漏了新增的 3 个字段 |
| 影响 | GPU 渲染完全失效 |
| 修复时间 | ~5 分钟（定位后） |

## 问题现象

用户报告：
- 纹理笔刷 roundness 工作正常
- 圆头笔刷（parametric brush）roundness 无效
- 画出来的圆形边缘被"方形裁剪"，即使 roundness=100% 也这样

## 根因分析

### 修改链路

为 GPU parametric brush 添加 roundness 支持需要修改 5 个文件：

```
1. types.ts          → DabInstanceData 接口添加 roundness/angleCos/angleSin
2. computeBrush.wgsl → DabData 结构体 + compute_ellipse_distance()
3. ComputeBrushPipeline.ts → packDabData() 打包新字段
4. GPUStrokeAccumulator.ts → stampDab() 计算并传递新字段
5. InstanceBuffer.ts → push() 存储新字段 ← ❌ 遗漏
```

### 遗漏点

`InstanceBuffer.ts` 的 `push()` 方法只存储了 9 个字段（offset 0-8），**没有存储新增的 offset 9-11**：

```typescript
// 修改前
this.cpuData[offset + 0] = dab.x;
// ... offset 1-8 ...
this.cpuData[offset + 8] = dab.flow;
// ❌ 遗漏 offset 9-11

// 修改后
this.cpuData[offset + 9] = dab.roundness;   // ✅ 新增
this.cpuData[offset + 10] = dab.angleCos;   // ✅ 新增
this.cpuData[offset + 11] = dab.angleSin;   // ✅ 新增
```

### 为什么会出现"方形裁剪"

GPU 读取的 `roundness/angle_cos/angle_sin` 是未初始化的值（Float32Array 默认为 0）：

1. `roundness = 0` → shader 中 `scaled_y = rotated_y / 0.0` 产生 `Inf`
2. `angle_cos = 0, angle_sin = 0` → 旋转矩阵退化，所有点映射到同一位置
3. 椭圆距离计算返回 `NaN` 或 `Inf` → `compute_mask()` 行为异常
4. 最终表现为边缘被裁剪的视觉 bug

### 为什么纹理笔刷正常

纹理笔刷使用独立的 `TextureInstanceBuffer`，其 `push()` 方法在之前就已经正确实现了 12 个字段的存储。

## 教训总结

### 1. 数据链路要完整验证

修改 GPU 数据结构时，必须检查完整的数据流：

```
接口定义 → 数据创建 → 数据存储 → 数据打包 → GPU 读取
```

本次遗漏了"数据存储"环节（`InstanceBuffer.push()`）。

### 2. TypeScript 无法检测运行时数据遗漏

即使 `DabInstanceData` 接口添加了新字段，`push()` 方法使用的是数组索引访问 `cpuData[offset + N]`，TypeScript 无法检测索引是否完整覆盖所有字段。

**改进建议**：考虑使用类型安全的打包方式，或添加断言检查：
```typescript
console.assert(DAB_FLOATS_PER_INSTANCE === 12, 'DabData field count mismatch');
```

### 3. 未初始化数据的危险

GPU shader 读取未初始化数据时不会报错，只会产生难以预测的渲染结果。本次的"方形裁剪"现象就是 `NaN/Inf` 在 shader 中传播的结果。

### 4. 对照检查法

当修改涉及多个并行实现时（如 parametric brush 和 texture brush），可以对照已工作的实现来检查遗漏。本次如果早点检查 `TextureInstanceBuffer.push()` 的实现，就能更快发现问题。

## 修复验证

1. 类型检查通过：`pnpm typecheck`
2. 手动测试：
   - roundness = 100% → 完整圆形（无裁剪）✅
   - roundness < 100% → 椭圆形 ✅
   - 调整 angle → 椭圆旋转 ✅

## 相关文件

- `src/gpu/resources/InstanceBuffer.ts` - push() 方法
- `src/gpu/types.ts` - DabInstanceData 接口
- `src/gpu/shaders/computeBrush.wgsl` - DabData 结构体

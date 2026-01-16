# GPU 动态降采样优化 Postmortem

> 日期: 2026-01-16 | 作者: AI Assistant

## 概述

实现 GPU 渲染动态降采样（Q4），从手动三档选择改为自动判断模式。

## 时间线

1. **初始实现**：三档手动选择（100%/75%/50%）
2. **用户测试反馈**：硬笔刷降采样锯齿明显，不可接受
3. **改进方案**：Auto/Off 模式，仅对软大笔刷自动降采样

## 关键发现

### 硬笔刷 vs 软笔刷降采样效果

| 笔刷类型               | 降采样效果  | 原因                                         |
| ---------------------- | ----------- | -------------------------------------------- |
| 软笔刷 (hardness < 70) | ✅ 可接受   | 边缘本身模糊，上采样后差异不明显             |
| 硬笔刷 (hardness ≥ 70) | ❌ 锯齿明显 | 边缘锐利，上采样时 nearest neighbor 产生阶梯 |

### 最终触发条件

```typescript
const shouldDownsample = mode === 'auto' && brushHardness < 70 && brushSize > 300;
const targetScale = shouldDownsample ? 0.5 : 1.0;
```

## 经验教训

### 1. 先验证再扩展

❌ 原方案：提供三档让用户自己选
✅ 改进：自动判断，只在确定有效的场景启用

### 2. 降采样适用条件

- **大笔刷**：像素数量是瓶颈时才有意义（size > 300）
- **软边缘**：上采样误差可被模糊掩盖（hardness < 70）
- **预览场景**：最终合成仍用原始分辨率

### 3. M3 纹理预生成 vs 直接做 ABR

分析发现：如果后续要实现 PS 纹理笔刷，M3 的纹理缓存基础设施可复用。

**建议**：跳过纯高斯纹理预生成，直接做通用纹理缓存 + ABR 解析，一次到位。

## 影响的文件

| 文件                                  | 变更                                  |
| ------------------------------------- | ------------------------------------- |
| `src/stores/tool.ts`                  | `GPURenderScaleMode: 'auto' \| 'off'` |
| `src/gpu/GPUStrokeAccumulator.ts`     | `syncRenderScale` 自动判断逻辑        |
| `src/gpu/resources/PingPongBuffer.ts` | 缩放纹理支持                          |
| `src/components/BrushPanel/index.tsx` | Downsample UI                         |

## 后续建议

1. 可考虑双线性插值上采样（当前是 nearest neighbor）
2. 动态调整阈值：根据实际 GPU Execute 时间自适应
3. 用户反馈收集：观察 Auto 模式是否满足多数场景

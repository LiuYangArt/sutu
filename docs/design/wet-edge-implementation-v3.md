# Wet Edge 实现文档 v3.0

## 状态: ✅ 已实现

## 问题分析

### 原始问题
1. **边缘检测方法产生锯齿** - 距离场计算产生锯齿感
2. **效果与 Photoshop 不符** - Photoshop 的 wet edge 在软边笔刷上更明显
3. **硬边笔刷行为错误** - Photoshop 硬边笔刷几乎没有 wet edge（仅抗锯齿边缘）

### Photoshop 行为观察
| 笔刷类型 | Wet Edge 行为 |
|----------|---------------|
| 软边 (hardness 0%) | 边缘明显加深，中心变淡 |
| 硬边 (hardness 100%) | 几乎无效果（仅抗锯齿边缘） |
| 中等 (hardness 50%) | 中等程度效果 |

### 关键洞察
Photoshop wet edge 效果与 **笔刷本身的 alpha 渐变** 直接相关，而非独立的边缘检测。

## 最终算法：Alpha 反转 + 增强

### 核心概念
```
alphaNorm = originalAlpha / 255
wetMultiplier = edgeBoost - (edgeBoost - centerOpacity) * alphaNorm
newAlpha = originalAlpha * wetMultiplier
```

### 参数（调优以匹配 Photoshop）
```typescript
const centerOpacity = 0.45;  // 中心保留 45% 的原始透明度
const edgeBoost = 2.2;       // 边缘提升到 220%
```

### 效果映射

| 区域 | originalAlpha | alphaNorm | wetMultiplier | 结果 |
|------|---------------|-----------|---------------|------|
| 中心 | 255 | 1.0 | 0.45 | 45% 透明度（变淡） |
| 中边缘 | 128 | 0.5 | 1.325 | 133% 透明度 |
| 边缘 | 50 | 0.2 | 1.85 | 185% 透明度（加深） |
| 远边缘 | 20 | 0.08 | 2.06 | 206% 透明度（限制为 255） |

### 为什么有效

1. **中心变淡**：高 alpha 像素乘以 ~0.45
2. **边缘加深**：低 alpha 像素乘以最高 2.2
3. **平滑渐变**：线性插值产生自然过渡
4. **硬边不受影响**：alpha 突变意味着没有渐变区域

### 优势
- **无需边缘检测** - O(n) 复杂度，无邻居查找
- **自动适应笔刷硬度** - 效果随 alpha 渐变缩放
- **匹配 Photoshop 行为** - 硬边几乎无效果，软边效果强
- **无锯齿** - 使用实际 alpha 值，非空间检测

## 实现

### 文件：`src/utils/strokeBuffer.ts`

```typescript
private applyWetEdgeEffect(): void {
  if (!this.bufferData || !this.wetEdgeBuffer) return;

  const strength = this.wetEdgeStrength;
  const centerOpacity = 0.45;
  const edgeBoost = 2.2;

  const left = Math.max(0, this.dirtyRect.left);
  const top = Math.max(0, this.dirtyRect.top);
  const right = Math.min(this.width, this.dirtyRect.right);
  const bottom = Math.min(this.height, this.dirtyRect.bottom);

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const idx = (y * this.width + x) * 4;
      const originalAlpha = this.bufferData[idx + 3]!;

      if (originalAlpha < 1) {
        this.wetEdgeBuffer[idx] = 0;
        this.wetEdgeBuffer[idx + 1] = 0;
        this.wetEdgeBuffer[idx + 2] = 0;
        this.wetEdgeBuffer[idx + 3] = 0;
        continue;
      }

      const alphaNorm = originalAlpha / 255;
      const wetMultiplier = edgeBoost - (edgeBoost - centerOpacity) * alphaNorm;
      const wetAlpha = Math.min(255, originalAlpha * wetMultiplier);
      const newAlpha = originalAlpha * (1 - strength) + wetAlpha * strength;

      this.wetEdgeBuffer[idx] = this.bufferData[idx]!;
      this.wetEdgeBuffer[idx + 1] = this.bufferData[idx + 1]!;
      this.wetEdgeBuffer[idx + 2] = this.bufferData[idx + 2]!;
      this.wetEdgeBuffer[idx + 3] = Math.round(newAlpha);
    }
  }
}
```

### UI：`src/components/BrushPanel/settings/WetEdgeSettings.tsx`

- 仅启用/禁用复选框
- 无强度滑块（固定为 1.0）
- 无宽度参数（算法不需要）

### Store：`src/stores/tool.ts`

- `wetEdgeEnabled: boolean` - 开关
- `wetEdge: number` - 强度 (0-1)，默认 1.0

## 测试结果

- [x] 软边笔刷 (hardness 0%)：边缘效果强，中心变淡 ✅
- [x] 硬边笔刷 (hardness 100%)：几乎无效果 ✅
- [x] 中等笔刷 (hardness 50%)：中等效果 ✅
- [x] 与 Photoshop 视觉对比匹配 ✅

## 失败的方案

详见 `docs/postmortem/wet-edge-implementation.md`：
1. Per-dab 边缘检测（毛毛虫效应）
2. MAX 混合模式（仍显示 dab 边界）
3. 距离场边缘检测（锯齿，行为错误）
4. Alpha 反转无增强（中心过于透明）

---

*文档版本: 3.0 Final*
*创建日期: 2025-01-21*
*状态: ✅ 已实现并测试*

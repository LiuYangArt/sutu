# Postmortem: Wet Edge 实现

## 日期
2025-01-21

## 问题描述
实现 Photoshop 风格的 Wet Edge（湿边）效果，使笔刷边缘更深、中心更浅，模拟水彩颜料在边缘聚集的效果。

## 失败尝试

### 尝试 1: Per-Dab 边缘检测
**方法**: 在每个 dab 级别应用 wet edge，使用 `pow(mask, 3.0)` 调整 mask profile。

**结果**: 产生"毛毛虫效果"——每个 dab 都有独立的边缘环，而非整条笔划有统一边缘。

**教训**: Wet edge 必须在 stroke buffer 级别后处理，不能在 dab 级别。

### 尝试 2: MAX Blend + Per-Dab
**方法**: 使用 MAX blend mode 替代 Alpha Darken，防止 dab 重叠累积。

**结果**: 仍然有每个 dab 的边界可见。

**教训**: 即使混合模式正确，per-dab 方法本质上无法产生 stroke 级别的边缘效果。

### 尝试 3: 距离场边缘检测
**方法**: 在 stroke buffer 后处理阶段，计算每个像素到透明边缘的距离，基于距离调整 alpha。

**结果**:
- 产生锯齿感
- 与 Photoshop 行为不符（硬边笔刷应几乎无效果）
- 计算开销大 O(n × radius²)

**教训**: 空间距离检测不是正确方向，应该利用笔刷自身的 alpha 梯度。

### 尝试 4: Alpha 反转（仅增加）
**方法**: `newAlpha = originalAlpha + (255 - originalAlpha) * mask * strength`

**结果**: 几乎无可见效果，因为中心 alpha 已经是 255，加再多也没用。

**教训**: 需要降低中心 alpha，而非增加边缘 alpha。

### 尝试 5: Alpha 反转（仅降低中心）
**方法**: 使用 inverted alpha 作为乘数，中心变透明。

**结果**: 中心完全透明，效果过于极端。

**教训**: 中心需要保留部分 opacity（约 50-60%），不能完全透明。

## 最终成功方案

### 核心算法
```typescript
const centerOpacity = 0.45;  // 中心保留 45%
const edgeBoost = 2.2;       // 边缘提升到 220%

const alphaNorm = originalAlpha / 255;
const wetMultiplier = edgeBoost - (edgeBoost - centerOpacity) * alphaNorm;
const wetAlpha = Math.min(255, originalAlpha * wetMultiplier);
const newAlpha = originalAlpha * (1 - strength) + wetAlpha * strength;
```

### 效果映射
| 区域 | alphaNorm | wetMultiplier | 效果 |
|------|-----------|---------------|------|
| 中心 (alpha=255) | 1.0 | 0.45 | 降至 45% |
| 边缘 (alpha→0) | →0 | →2.2 | 提升至 220% |

### 为什么有效
1. **利用笔刷自身的 alpha 梯度**: 软边笔刷有渐变 alpha，自然形成 wet edge；硬边笔刷 alpha 突变，几乎无效果区域
2. **无需边缘检测**: O(n) 复杂度，无锯齿
3. **自适应笔刷硬度**: 完美匹配 Photoshop 行为
4. **参数简单**: 只需 centerOpacity 和 edgeBoost 两个参数

## 关键洞察

### Photoshop Wet Edge 的本质
Wet edge 不是"检测边缘然后加深"，而是：
- **中心变淡** + **边缘相对变深**
- 效果强度与笔刷的 alpha 梯度直接相关
- 硬边笔刷（alpha 突变）几乎无 wet edge 区域

### 正确的心智模型
```
原始 alpha 梯度:  中心=高, 边缘=低
Wet edge 变换:    中心×0.45, 边缘×2.2
结果:             中心变淡, 边缘变深 → 水彩效果
```

## 架构决策

### 在 Stroke Buffer 级别后处理
- Wet edge effect 在 `syncPendingToCanvas()` 时应用
- 使用独立的 `wetEdgeBuffer` 存储处理结果
- 不影响原始 stroke buffer 数据

### 移除 wetEdgeWidth 参数
最初添加了 width 参数用于边缘检测方法，但 alpha 反转方法不需要，已移除简化 API。

## 文件变更
- `src/utils/strokeBuffer.ts`: 核心算法实现
- `src/stores/tool.ts`: wetEdgeEnabled 状态
- `src/components/BrushPanel/settings/WetEdgeSettings.tsx`: UI 开关

## 未来改进
- 可考虑将 centerOpacity 和 edgeBoost 暴露为用户可调参数
- GPU 实现可进一步优化性能

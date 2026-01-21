# Wet Edge 实现方案设计文档

> 版本: 2.0 | 创建日期: 2026-01-21 | 更新日期: 2026-01-21

## 问题分析

### 当前错误实现

当前实现在**每个 dab 渲染时**应用 wet edge 效果，导致：
- 每个 dab 都有独立的深色边缘
- 最终效果呈现"串珠"状（图形学中称为 **"毛毛虫效应" / Caterpillar Effect**）
- 重叠处透明度累加变黑（**"重叠伪影" / Overlap Artifacts**）

### 根本原因

**混合模式错误**：当前使用累加混合（Alpha Darken），导致重叠处透明度叠加：
```
Dab A: 0.6 + Dab B: 0.6 = 0.84 → 越来越深
```

### Photoshop 正确行为

Photoshop 的 Wet Edge 使用 **MAX 混合**（取最大值）：
```
max(0.6, 0.6) = 0.6 → 保持恒定
```

这就是为什么 PS 的 wet edge 是平滑的"管状"，而不是"毛毛虫"。

---

## 技术方案

### 方案对比 (更新)

| 方案 | 描述 | 预览一致性 | 性能 | 复杂度 |
|------|------|------------|------|--------|
| ~~A: 后处理~~ | ~~endStroke 时应用~~ | ❌ | ✅ | 低 |
| ~~B: 双缓冲边缘检测~~ | ~~维护两个 buffer + 距离场~~ | ✅ | ⚠️ | 高 |
| **C: MAX 混合 (推荐)** | **修改 dab 混合模式为 MAX** | ✅ | ✅ | **低** |

**推荐方案: C (MAX 混合)**

这个方案来自 Review 的关键洞察：问题不在于"在哪里计算边缘"，而在于"混合模式错误"。

---

## 方案 C: MAX 混合实现

### 核心思路

1. **修改混合模式**：Wet Edge 模式下使用 `max(dstAlpha, dabTargetAlpha)` 而非累加
2. **调整 Mask 曲线**：使用 `pow(mask, 4.0)` 让中心平坦、边缘陡峭
3. **透明度分布**：边缘保持较高不透明度 (80%)，中心减淡 (40%)

### 数学模型

```typescript
// 1. 形状重塑 (Profile Shaping)
// pow(x, 4.0) 让中心平坦区域更宽，边缘衰减更急促
const shapeProfile = Math.pow(mask, 4.0);

// 2. 计算单次 Dab 的目标 Alpha
// 边缘(mask~0.1)保留 80% 不透明度，中心(mask~1.0)降到 40%
const CENTER_OPACITY = 0.4;
const EDGE_OPACITY = 0.8;

// mask=1 时用 CENTER_OPACITY, mask=0 时用 EDGE_OPACITY
const profileAlpha = EDGE_OPACITY - (EDGE_OPACITY - CENTER_OPACITY) * shapeProfile;

// 结合 flow 和原始 mask (裁剪形状)
const dabTargetAlpha = mask * flow * profileAlpha;

// 3. MAX 混合 (核心去伪影步骤)
// 取最大值，不要累加！
const finalAlpha = Math.max(dstAlpha, dabTargetAlpha);
```

### 数据流

```
┌─────────────────────────────────────────────────────────────┐
│                    Wet Edge Dab Rendering                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Input: mask (0→1), flow, wetEdge strength                  │
│                      │                                       │
│                      ▼                                       │
│         ┌────────────────────────┐                          │
│         │  Shape Profile (pow)   │                          │
│         │  pow(mask, 4.0)        │                          │
│         └───────────┬────────────┘                          │
│                     │                                        │
│                     ▼                                        │
│         ┌────────────────────────┐                          │
│         │  Profile Alpha         │                          │
│         │  edge=0.8, center=0.4  │                          │
│         └───────────┬────────────┘                          │
│                     │                                        │
│                     ▼                                        │
│         ┌────────────────────────┐                          │
│         │  Dab Target Alpha      │                          │
│         │  mask * flow * profile │                          │
│         └───────────┬────────────┘                          │
│                     │                                        │
│                     ▼                                        │
│         ┌────────────────────────┐                          │
│         │  MAX Blend             │  ◄── 核心：消除毛毛虫    │
│         │  max(dst, dabTarget)   │                          │
│         └───────────┬────────────┘                          │
│                     │                                        │
│                     ▼                                        │
│              Stroke Buffer                                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 为什么 MAX 混合能消除毛毛虫

模拟"水渍的形状"：当你把两滴同样高度的水滴在一起，它们的高度不会变成两倍，而是融合在一起。

- **累加混合**：`0.6 + 0.6 × (1 - 0.6) = 0.84` → 重叠处变深
- **MAX 混合**：`max(0.6, 0.6) = 0.6` → 重叠处保持恒定

---

## 实现计划

### Phase 1: 修改混合逻辑

**文件修改**:
- `src/utils/maskCache.ts`
- `src/utils/textureMaskCache.ts`

**核心改动**:

```typescript
// maskCache.ts - blendPixel 或 stampToBuffer 内部

if (wetEdge > 0) {
  // 1. 形状重塑
  const shapeProfile = Math.pow(maskValue, 4.0);

  // 2. 透明度分布 (可配置参数)
  const centerOpacity = 0.4 * wetEdge + (1 - wetEdge) * 1.0;
  const edgeOpacity = 0.8 * wetEdge + (1 - wetEdge) * 1.0;
  const profileAlpha = edgeOpacity - (edgeOpacity - centerOpacity) * shapeProfile;

  // 3. 计算 dab 目标 alpha
  const dabTargetAlpha = maskValue * flow * profileAlpha * dabOpacity;

  // 4. MAX 混合 (核心)
  const dstA = buffer[idx + 3]! / 255;
  const finalAlpha = Math.max(dstA, dabTargetAlpha);

  // 5. 颜色混合 (仅当 alpha 增加时更新颜色)
  if (finalAlpha > dstA + 0.001) {
    const blend = (finalAlpha - dstA) / finalAlpha;
    buffer[idx] = buffer[idx]! * (1 - blend) + r * blend + 0.5;
    buffer[idx + 1] = buffer[idx + 1]! * (1 - blend) + g * blend + 0.5;
    buffer[idx + 2] = buffer[idx + 2]! * (1 - blend) + b * blend + 0.5;
  }
  buffer[idx + 3] = finalAlpha * 255 + 0.5;

  return; // 跳过常规混合
}

// 原有的 Alpha Darken 混合逻辑...
```

### Phase 2: 优化 Spacing

**建议**：Wet Edge 模式下自动降低 Spacing 到 10% 或更低

```typescript
// useBrushRenderer.ts 或 BrushStamper
const effectiveSpacing = config.wetEdgeEnabled
  ? Math.min(config.spacing, 0.1)  // Wet Edge 强制最大 10%
  : config.spacing;
```

### Phase 3: 可调参数 (可选)

在 `WetEdgeSettings.tsx` 中添加高级参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| Edge Opacity | 0.8 | 边缘不透明度 |
| Center Opacity | 0.4 | 中心不透明度 |
| Profile Power | 4.0 | 曲线指数，越大边缘越锐利 |

---

## 与旧方案的对比

| 维度 | 旧方案 (双缓冲边缘检测) | 新方案 (MAX 混合) |
|------|-------------------------|-------------------|
| 复杂度 | 高 (距离场、JFA) | 低 (修改混合公式) |
| 性能开销 | 中等 (后处理) | 几乎无 |
| 预览一致性 | 需要额外处理 | 自然一致 |
| 代码改动量 | 大 (新增 processor) | 小 (修改现有函数) |

---

## 验证计划

1. **毛毛虫消除测试**：
   - 使用大笔刷 (100px+)、低 Spacing (25%)
   - 确认重叠处不再变黑

2. **视觉对比**：
   - 与 Photoshop Wet Edge 效果截图对比
   - 确认边缘深、中心浅的"水渍"效果

3. **性能测试**：
   - 确认无额外帧率影响

---

## 参考资料

- Review 分析：毛毛虫效应的根因是混合模式错误
- Photoshop 使用 MAX 混合模拟水滴融合行为
- `pow(mask, 4.0)` 曲线重塑产生"干涸水渍"边缘

# Blend Mode CPU/GPU 对齐实施计划

## 背景

Texture 笔刷混合模式在 UI 中定义了 10 种，但 CPU 和 GPU 渲染路径实现不完整且不一致。需要补齐缺失模式，确保 CPU (ground truth) 和 GPU (性能优先) 效果一致。

## 调研结论

### Texture 混合模式 (10种)

| 模式         | CPU `textureRendering.ts` | GPU `computeBrush.wgsl` |
| ------------ | ------------------------- | ----------------------- |
| multiply     | ⚠️ 简化 lerp              | ✅ mode=0               |
| subtract     | ✅ 已实现                 | ✅ mode=1               |
| darken       | ❌ fallback               | ✅ mode=2               |
| overlay      | ❌ fallback               | ✅ mode=3               |
| colorDodge   | ❌ fallback               | ✅ mode=4               |
| colorBurn    | ❌ fallback               | ✅ mode=5               |
| linearBurn   | ❌ fallback               | ✅ mode=6               |
| hardMix      | ❌ fallback               | ✅ mode=7               |
| linearHeight | ✅ 已实现                 | ✅ mode=8               |
| height       | ✅ 已实现                 | ✅ mode=9               |

### Dual Brush 混合模式 (8种)

CPU/GPU 已完全对齐，无需修改。

---

## Proposed Changes

### CPU Rendering

#### [MODIFY] [textureRendering.ts](file:///f:/CodeProjects/PaintBoard/src/utils/textureRendering.ts)

补齐 `calculateTextureInfluence()` 函数中缺失的 6 种混合模式：

- `darken`: `min(1.0, blend)`
- `overlay`: 标准 overlay 公式
- `colorDodge`: `min(1.0, base / (1.0 - blend))`
- `colorBurn`: `max(0, 1.0 - (1.0 - base) / blend)`
- `linearBurn`: `max(0, base + blend - 1.0)`
- `hardMix`: `base + blend >= 1.0 ? 1.0 : 0.0`

并修正现有模式：

- `multiply`: 改为标准 `base * blend`
- `linearHeight`: `base * (0.5 + blend * 0.5)`
- `height`: `min(1.0, base * 2.0 * blend)`（高度图：0.5 为中性，允许抬高）

---

### GPU Shaders

#### [MODIFY] [computeBrush.wgsl](file:///f:/CodeProjects/PaintBoard/src/gpu/shaders/computeBrush.wgsl)

在 `apply_blend_mode()` 函数添加：

```wgsl
case 8u: { // Linear Height
  return base * (0.5 + blend * 0.5);
}
case 9u: { // Height
  return min(1.0, base * 2.0 * blend);
}
```

#### [MODIFY] [computeTextureBrush.wgsl](file:///f:/CodeProjects/PaintBoard/src/gpu/shaders/computeTextureBrush.wgsl)

同上，添加 case 8 和 9。

---

### Mode Mapping

需确保 TypeScript 到 GPU 的模式映射一致：

| TextureBlendMode | GPU mode |
| ---------------- | -------- |
| multiply         | 0        |
| subtract         | 1        |
| darken           | 2        |
| overlay          | 3        |
| colorDodge       | 4        |
| colorBurn        | 5        |
| linearBurn       | 6        |
| hardMix          | 7        |
| linearHeight     | 8        |
| height           | 9        |

检查 `GPUStrokeAccumulator.ts` 或 pipeline 中 pattern_mode 的映射逻辑。

---

## Verification Plan

### Automated Tests

1. 扩展 `textureRendering.test.ts`，为每种模式添加单元测试
2. 运行 `pnpm check:all` 确保无类型错误

### Manual Verification

1. 启动 `pnpm dev`
2. 选择 Texture 笔刷，逐一切换 10 种 Mode
3. 对比 CPU 渲染器 (fallback) 和 GPU 渲染器效果是否一致
4. 重点验证：`darken`, `overlay`, `linearHeight` 视觉效果

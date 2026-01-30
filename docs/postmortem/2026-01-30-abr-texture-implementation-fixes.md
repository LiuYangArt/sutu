# Texture Implementation Fixes (Brightness/Contrast & Data Flow)

**日期**: 2026-01-30
**标签**: `bugfix` `rendering` `data-flow` `texture-system`

## 1. 问题背景

在实现 ABR 笔刷纹理支持的过程中，用户反馈了两个主要问题：

1.  即便在 UI 中启用了纹理，笔触依然没有应用任何纹理效果。
2.  修复显示问题后，调节 "Brightness" 和 "Contrast" 滑块没有任何视觉效果。
3.  修复计算逻辑后，用户反馈 Brightness 的效果是反的，且 Contrast 的范围 (-50 到 100) 需要特殊处理。

## 2. 根因分析

### 2.1 纹理不显示 (Data Flow Gap)

**原因**: 数据流在 React 组件层断裂。
虽然 `useToolStore` 正确更新了全局 `textureSettings`，但在 `Canvas/index.tsx` 中构建 `BrushRenderConfig` 时，**漏传了 `textureSettings` 字段**。

```typescript
// Before
const getBrushConfig = useCallback((): BrushRenderConfig => {
  return {
    // ... other props
    textureEnabled,
    // textureSettings MISSING!
  };
}, [...]);
```

这导致 `useBrushRenderer` 接收到的配置中 `textureSettings` 为 `undefined`，底层的 `processPoint` 逻辑虽然包含纹理处理代码，但因缺少配置而直接跳过。

### 2.2 亮度/对比度无效 (Unimplemented Feature)

**原因**: `textureRendering.ts` 中的逻辑处于 TODO 状态。
开发者（我）在为了性能优化（避免不必要的逐像素计算）时，注释掉了亮度和对比度的计算代码，但忘记在 UI启用这些功能时恢复它。

```typescript
// src/utils/textureRendering.ts (Old)
// Brightness / Contrast (Optional, skipping for optimization unless requested)
// if (settings.brightness !== 0 || settings.contrast !== 0) { ... }
```

### 2.3 亮度逻辑反转 (UX Mismatch)

**原因**: 对 "Brightness" 语义的理解差异。
在代码实现中，`Brightness` 最初被实现为简单的像素值增加 (`val += brightness`)。
但在 `Multiply`（正片叠底）混合模式下：

- 纹理像素值越高（越白） -> 遮罩效果越弱（越透明）。
- 纹理像素值越低（越黑） -> 遮罩效果越强（越明显）。

用户调整 Brightness 通常期望的是增强/减弱纹理的**可见性**或**强度**。

- 当前实现：增加亮度 -> 纹理变白 -> 效果变弱。
- 用户期望：增加亮度 -> 纹理效果变强（或变暗）。

这导致了用户感觉 "效果反了"。

## 3. 解决方案

### 3.1 修复数据流

在 `src/components/Canvas/index.tsx` 中，将 `textureSettings` 添加到 `getBrushConfig` 的返回值和依赖数组中。

### 3.2 实现亮度/对比度算法

在 `src/utils/textureRendering.ts` 中实现了标准的图像处理算法，并根据用户反馈反转了亮度逻辑。

```typescript
// Brightness (Inverted logic for Masking context)
if (settings.brightness !== 0) {
  // Slide Right (+) -> Darker Texture -> Stronger Mask
  texVal -= settings.brightness / 255.0;
}

// Contrast (Standard algorithm adapted for -50..100 range)
if (settings.contrast !== 0) {
  const factor = Math.pow((settings.contrast + 100) / 100, 2);
  texVal = (texVal - 0.5) * factor + 0.5;
}
```

### 3.3 补充测试

更新了 `src/utils/textureRendering.test.ts`，增加了针对 Brightness（反转后逻辑）和 Contrast 的单元测试，确保边界条件（如全黑/全白）处理正确。

## 4. 经验教训 (Action Items)

1.  **特性完整性检查**: 在 UI 暴露任何控制（如滑块）之前，必须确认底层逻辑已实现。不要保留 "TODO" 代码在生产路径上。
2.  **数据流审计**: 当添加新的笔刷属性时，需要从 Store -> Canvas component -> useBrushRenderer -> StrokeBuffer -> Rust/Shader 进行全链路检查。当前的手动传递方式容易漏字段。
    - _Idea_: 考虑使用 TypeScript 类型工具强制 `BrushRenderConfig` 与 Store 状态的映射，或者减少中间层的解构。
3.  **视觉算法的语义确认**: 对于涉及视觉效果的参数（如亮度、强度），尤其是涉及混合模式（Masking）时，其对最终效果的影响可能与直觉相反。应尽早提供预览或进行验证。

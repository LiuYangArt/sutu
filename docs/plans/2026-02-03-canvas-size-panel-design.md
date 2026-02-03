# 画布大小设置面板

在global Toolbar 右上角添加画布大小设置入口，点击后弹出浮动面板，支持修改画布尺寸、锚点选择、缩放模式切换等功能。

## 功能需求

| 功能       | 说明                                                   |
| ---------- | ------------------------------------------------------ |
| 入口       | Toolbar 右上角，`ImageUpscale` 图标                    |
| 面板样式   | 浮动面板，类似 Pattern Library（overlay + mica-panel） |
| 当前尺寸   | 显示当前宽 × 高 px                                     |
| 新尺寸输入 | 宽/高 px 输入框                                        |
| 保持等比   | Toggle，默认开启（链条图标）                           |
| 模式切换   | Toggle：裁切/扩展 ↔ 缩放内容                           |
| 锚点选择   | 9 宫格（仅裁切/扩展模式可用）                          |
| 扩展填充色 | 预设下拉：透明、白、黑、当前背景色（仅裁切/扩展模式）  |
| Resample   | 下拉：Nearest / Bilinear / Bicubic（仅缩放模式可用）   |

> [!TIP]
> **备选方案**：若 Bicubic 质量不足，后续可引入 `pica` 库（~15KB）支持 Lanczos3 算法。

---

## Proposed Changes

### CanvasSizePanel 组件

#### [NEW] [CanvasSizePanel.tsx](file:///f:/CodeProjects/PaintBoard/src/components/CanvasSizePanel/CanvasSizePanel.tsx)

- Props: `isOpen`, `onClose`, `onApply`
- 状态: `newWidth`, `newHeight`, `keepAspectRatio`, `scaleContent`, `anchor`, `extensionColor`, `resampleMode`
- 9 宫格锚点选择器（3x3 按钮网格）
- Resample 下拉选择（Nearest / Bilinear / Bicubic）
- Apply / Cancel 按钮

#### [NEW] [CanvasSizePanel.css](file:///f:/CodeProjects/PaintBoard/src/components/CanvasSizePanel/CanvasSizePanel.css)

复用 Pattern Library 面板样式。

---

### Toolbar 工具栏

#### [MODIFY] [index.tsx](file:///f:/CodeProjects/PaintBoard/src/components/Toolbar/index.tsx)

在 Undo/Redo 按钮组**之前**添加画布大小按钮（`ImageUpscale` 图标）。

---

### 画布 Resize 逻辑

#### [MODIFY] [document.ts](file:///f:/CodeProjects/PaintBoard/src/stores/document.ts)

添加 `resizeCanvas` action：

```ts
interface ResizeCanvasOptions {
  width: number;
  height: number;
  anchor:
    | 'top-left'
    | 'top'
    | 'top-right'
    | 'left'
    | 'center'
    | 'right'
    | 'bottom-left'
    | 'bottom'
    | 'bottom-right';
  scaleContent: boolean;
  extensionColor: string;
  resampleMode: 'nearest' | 'bilinear' | 'bicubic';
}
```

通过 `window.__canvasResize?.(options)` 暴露，Canvas 组件调用 `layerRenderer.resize()` 配合锚点偏移。

---

## Verification Plan

### 手动验证

1. **面板打开** — 点击 `ImageUpscale` 图标弹出面板
2. **保持等比** — 修改宽度后高度自动按比例更新
3. **锚点选择** — 9 宫格选中状态正确
4. **模式切换** — 锚点/填充色在缩放模式下禁用，Resample 在裁切模式下禁用
5. **应用修改** — 画布尺寸更新，内容按设置正确处理

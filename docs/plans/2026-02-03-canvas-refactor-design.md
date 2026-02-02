# Canvas 重构与工具独立 Toolbar

拆分 `Canvas/index.tsx` (1957 行 → ~800 行)，并实现 Toolbar 内容随工具切换。

---

## Proposed Changes

### Canvas Hooks 拆分

---

#### [NEW] [useLayerOperations.ts](file:///f:/CodeProjects/PaintBoard/src/components/Canvas/useLayerOperations.ts)

提取图层相关操作：

- `fillActiveLayer` - 填充图层
- `handleClearSelection` - 清除选区内容
- `handleClearLayer` - 清除图层
- `handleDuplicateLayer` - 复制图层
- `handleRemoveLayer` - 删除图层
- `handleUndo` / `handleRedo` - 撤销/重做
- `captureBeforeImage` / `saveStrokeToHistory` - 历史记录

**接口**：

```typescript
interface UseLayerOperationsParams {
  layerRendererRef: RefObject<LayerRenderer>;
  activeLayerId: string | null;
  layers: Layer[];
  width: number;
  height: number;
}
```

---

#### [NEW] [useGlobalExports.ts](file:///f:/CodeProjects/PaintBoard/src/components/Canvas/useGlobalExports.ts)

暴露 `window.__*` 全局方法：

- `__canvasFillLayer`
- `__canvasClearSelection`
- `__getLayerImageData`
- `__getFlattenedImage`
- `__getThumbnail`
- `__loadLayerImages`
- `__canvasUndo` / `__canvasRedo` / `__canvasClearLayer` 等

---

#### [NEW] [useKeyboardShortcuts.ts](file:///f:/CodeProjects/PaintBoard/src/components/Canvas/useKeyboardShortcuts.ts)

键盘快捷键处理：

- 工具切换 (B/E/M/S/Z)
- 笔刷大小调节 ([ ])
- 选区操作 (Ctrl+A/D, ESC)
- 撤销/重做 (Ctrl+Z/Y)

---

#### [NEW] [usePointerHandlers.ts](file:///f:/CodeProjects/PaintBoard/src/components/Canvas/usePointerHandlers.ts)

指针事件处理：

- `handlePointerDown`
- `handlePointerMove`
- `handlePointerUp`
- 平移/缩放/绘画/选区的分支逻辑

---

#### [NEW] [useStrokeProcessor.ts](file:///f:/CodeProjects/PaintBoard/src/components/Canvas/useStrokeProcessor.ts)

笔触处理和渲染循环：

- RAF loop
- `processSinglePoint`
- `finishCurrentStroke`
- 输入队列管理

---

#### [MODIFY] [index.tsx](file:///f:/CodeProjects/PaintBoard/src/components/Canvas/index.tsx)

调用上述 hooks，保留：

- refs 初始化
- LayerRenderer 初始化
- useEffect 组合
- JSX 渲染

预计 **800-900 行**。

---

### 工具独立 Toolbar

---

#### [NEW] [BrushToolbar.tsx](file:///f:/CodeProjects/PaintBoard/src/components/Toolbar/BrushToolbar.tsx)

Brush/Eraser 工具栏：

- Size/Flow/Opacity 滑块
- 压感开关
- 准心开关
- 笔刷设置按钮

---

#### [NEW] [SelectionToolbar.tsx](file:///f:/CodeProjects/PaintBoard/src/components/Toolbar/SelectionToolbar.tsx)

Selection/Lasso 工具栏：

- 暂时为空或仅显示提示文字
- 后续可扩展：羽化、反选等

---

#### [NEW] [ZoomToolbar.tsx](file:///f:/CodeProjects/PaintBoard/src/components/Toolbar/ZoomToolbar.tsx)

Zoom/Hand 工具栏：

- 缩放控件
- 适应窗口按钮

---

#### [MODIFY] [index.tsx](file:///f:/CodeProjects/PaintBoard/src/components/Toolbar/index.tsx)

根据 `currentTool` 渲染对应 Toolbar 组件：

```tsx
{
  (currentTool === 'brush' || currentTool === 'eraser') && <BrushToolbar />;
}
{
  (currentTool === 'select' || currentTool === 'lasso' || currentTool === 'polygon') && (
    <SelectionToolbar />
  );
}
{
  (currentTool === 'zoom' || currentTool === 'hand') && <ZoomToolbar />;
}
```

---

### 文档更新

---

#### [MODIFY] [architecture.md](file:///f:/CodeProjects/PaintBoard/docs/architecture.md)

更新「4.2 渲染引擎 (Canvas Renderer)」章节，补充 Canvas 模块拆分后的结构：

```
Canvas/
├── index.tsx           # 主组件，组合所有 hooks
├── useLayerOperations  # 图层操作
├── useGlobalExports    # window.__ 全局方法
├── useKeyboardShortcuts# 键盘快捷键
├── usePointerHandlers  # 指针事件
├── useStrokeProcessor  # 笔触处理/RAF
├── useBrushRenderer    # (已有) 笔刷渲染
├── useSelectionHandler # (已有) 选区处理
└── useCursor           # (已有) 光标
```

---

#### [MODIFY] [CLAUDE.md](file:///f:/CodeProjects/PaintBoard/CLAUDE.md)

更新「架构」章节的组件目录说明：

```
│  ├── components/→ React UI 组件                     │
│  │   ├── Canvas/    → 画布核心 (拆分为多个 hooks)    │
│  │   ├── Toolbar/   → 工具栏 (按工具动态切换)       │
│  │   └── ...                                        │
```

---

## Verification Plan

### Automated Tests

```bash
pnpm check:all
```

### Manual Verification

- 启动 `pnpm dev`，切换工具验证 Toolbar 切换
- 绘画/撤销/重做/图层操作正常
- 快捷键响应正常

---

## 风险评估

| 风险          | 影响       | 缓解措施                          |
| ------------- | ---------- | --------------------------------- |
| hook 依赖循环 | 构建失败   | 仔细规划 hook 输入/输出，单向依赖 |
| refs 传递过深 | 代码复杂度 | 使用 context 或合理归类 refs      |
| 回归 bug      | 功能异常   | 逐个 hook 拆分并验证              |

**置信度**：85% — 拆分模式清晰，但 refs 传递可能需要调整。

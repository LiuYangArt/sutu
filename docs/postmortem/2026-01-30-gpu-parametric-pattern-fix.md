# GPU 参数化笔刷纹理修复与状态同步问题分析

**日期**: 2026-01-30
**模块**: GPU Brush Engine / Pattern System
**标签**: #gpu #webgpu #state-management #debugging

## 背景

在实现 GPU 端参数化笔刷（普通圆头笔刷）的 Pattern Texture 功能时，遇到了多个层面的问题，从 GPU 资源验证错误到数据流状态同步 Bug。本文档记录了这三个主要问题的排查与解决过程。

## 问题排查与解决

### 1. GPU Validation Error (Invalid BindGroup)

**现象**:
启动绘制时，Console 报错 `GPUValidationError: Invalid BindGroup`，提示 Binding 类型不匹配。

**根因分析**:

- Shader 中定义 Pattern Texture Binding 为 `@group(0) @binding(5) var pattern_texture: texture_2d<f32>;`。
- WebGPU 默认 `texture_2d<f32>` 隐含要求 `sampleType: 'float'` (Filterable)。
- 代码中作为 Fallback（当没有 Pattern 时），复用了 `inputTexture`，其格式为 `rgba32float`。
- **关键冲突**: `rgba32float` 在 WebGPU 核心规范中由 `float32-filterable` 特性控制，默认是 **不可过滤 (Non-filterable)** 的。因此无法绑定到需要 Filterable 纹理的槽位。

**解决方案**:
在 `ComputeBrushPipeline` 中创建一个持久驻留的 1x1 白色 `rgba8unorm` 纹理 (`dummyPatternTexture`)。

- `rgba8unorm` 保证是 Filterable 的。
- 当没有 Pattern 时，绑定这个 Dummy Texture 而不是 `inputTexture`。

### 2. Library Pattern 无法加载 (异步时序问题)

**现象**:
修复 Validation Error 后，只有导入 ABR 文件自带的 Pattern 能正常显示。用户从 Library 手动选择的 Pattern 无效。

**根因分析**:

- GPU 渲染路径 (`GPUStrokeAccumulator`) 使用同步的 `patternCache.update()` -> `patternManager.getPattern()`。
- ABR 导入流程会预先加载所有 Pattern 数据到内存，所以 `getPattern()` 能立即返回数据。
- Library 选择的 Pattern 仅存储了 ID，并未触发预加载。GPU 尝试获取时返回 `undefined`，导致纹理被忽略。
- 相比之下，CPU 路径使用了 `await patternManager.loadPattern()`，掩盖了这个问题。

**解决方案**:
在 `GPUStrokeAccumulator.stampDab` 中添加异步触发逻辑：

```typescript
if (!patternManager.hasPattern(patternId)) {
  void patternManager.loadPattern(patternId); // Fire and forget
}
```

虽然第一笔可能因为加载延迟而没有纹理，但后续笔画能正常显示。

### 3. 状态不同步 (Split Source of Truth)

**现象**:
即使用了上述修复，Logs 显示 `textureSettings: { enabled: false, ... }`，导致纹理逻辑被跳过，即使 UI 上 "Texture" 开关已打开。

**根因分析**:
代码中存在两个 "Enabled" 状态源，违反了 SSOT (Single Source of Truth) 原则：

1. **`useToolStore.textureEnabled`**: 由 UI 复选框直接控制，传递给 `config.textureEnabled`。
2. **`textureSettings.enabled`**: `TextureSettings` 对象内部的一个字段。

`useBrushRenderer` 正确地使用了第一个开关来决定是否传递 `textureSettings` 对象。但是，`GPUStrokeAccumulator.extractPatternSettings` 内部又去检查了 `settings.enabled`。
由于 `textureSettings.enabled` 是一个历史遗留字段，没有被 UI 同步更新（一直默认为 false），导致逻辑短路。

**解决方案**:
**Code Simplification**: 彻底移除冗余状态。

1. 修改 `TextureSettings` 接口，删除 `enabled` 字段。
2. 更新 `DEFAULT_TEXTURE_SETTINGS`。
3. 清理所有依赖该字段的代码，统一使用顶层传入的 `config.textureEnabled` (表现为 `settings` 对象是否存在) 作为唯一判断标准。

## 总结与教训

1. **Single Source of Truth (SSOT)**:
   状态同步 Bug 是最隐蔽的。在设计数据结构时，应尽量避免冗余状态。本例中 `enabled` 既在外面又在里面，是典型反模式。一旦发现应立即重构清理，而不是打补丁同步。

2. **WebGPU 格式兼容性**:
   不要假设所有浮点纹理都是可过滤的。对于通用绑定槽位，使用 `rgba8unorm` 作为 Placeholder 是最安全的做法。

3. **同步 vs 异步假设**:
   在移植 CPU (Async) 逻辑到 GPU (Sync/Frame-based) 时，必须显式处理资源加载状态。GPU 渲染循环不能等待 Promise。

## 后续建议

- [x] 考虑在 Pattern Picker UI 组件中，当用户选择 Pattern 时就预先触发加载，而不是等到渲染时才触发，以减少"第一笔无纹理"的现象。(已于 2026-01-31 实现)

## 2026-01-31 更新：Pattern Pre-loading 实现

针对上述建议，我们实现了 Pattern 的预加载机制，有效解决了"第一笔无纹理"的问题。

### 实现方案

修改了 `PatternPicker.tsx` 组件，在用户点击选择 Pattern 的瞬间（`handlePatternClick`），立即调用 `patternManager.loadPattern(id)`。

```typescript
// PatternPicker.tsx
const handlePatternClick = (pattern: PatternResource) => {
  onSelect(pattern.id);
  setIsOpen(false);
  // Pre-load pattern immediately to avoid delay on first stroke
  void patternManager.loadPattern(pattern.id);
};
```

### 效果

利用用户关闭弹窗并移动鼠标到画布准备绘制的这段时间（通常数百毫秒到数秒），网络请求和解压过程在后台完成。当用户落笔时，`GPUStrokeAccumulator` 再次同步调用 `getPattern()` 时，数据通常已经准备就绪，从而消除了纹理加载延迟带来的视觉突变。

### 代码简化

同时，我们对 `PatternPicker.tsx` 进行了代码简化，将原来复杂的嵌套三元运算符重构为独立的 `renderGridContent` 函数，提升了代码的可读性。

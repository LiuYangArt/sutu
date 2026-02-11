# GPU 渐变全链路替换上线问题复盘（2026-02-11）

**日期**：2026-02-11  
**状态**：已修复

## 背景

GPU 渐变工具完成“预览 + 提交 + 历史”主链路替换后，进入真实交互验证阶段。  
在实际拖拽和撤销场景中，先后暴露两个稳定性问题：

1. GPU command buffer validation error（`SetScissorRect` 越界）。  
2. GPU 渐变提交后撤销，出现 CPU fallback warning（`Missing CPU beforeImage for undo fallback`）。

## 问题 1：Scissor Rect 越界导致 command buffer 失效

### 现象

在 1920x1080 画布中出现如下报错链：

1. `Scissor rect (x: 1536, width: 512) is not contained in the render target dimensions (1920 x 1080)`  
2. `Invalid CommandBuffer`  
3. 后续 `Preview Readback Encoder` 连续报错。

### 根因

显示阶段的 tile 绘制在边缘 tile 上仍使用完整 tile 大小（512），未对当前 canvas 实际尺寸做最终裁剪。  
当 tile 起点在右边缘（例如 `x=1536`）时，`1536 + 512 > 1920`，触发 WebGPU 验证错误。

### 修复

1. 在渲染入口增加尺寸自愈，保证 renderer 内部尺寸与 canvas 当前尺寸一致。  
2. 增加显示 viewport 裁剪逻辑，将 tile 视口 clamp 到 canvas bounds。  
3. 新增纯函数与单测覆盖边缘 tile 裁剪行为，防止回归。

## 问题 2：GPU 渐变撤销落到 CPU fallback warning

### 现象

执行 GPU 渐变后按 `Ctrl+Z`，控制台出现：

`[History] Missing CPU beforeImage for undo fallback`

### 根因

GPU 渐变提交路径虽然执行了 `beginStroke + captureBeforeTile + captureAfterTile`，  
但没有像画笔提交路径一样在结束时 `finalizeStroke(entryId)`。  
导致历史条目未进入 committed 集合，undo 时 GPU 历史 `apply()` 失败，只能走 CPU fallback，进而触发 warning。

### 修复

在 GPU 渐变提交回调的 `finally` 阶段补齐 `historyStore.finalizeStroke(historyEntryId)`，并保留原有 `clearPendingGpuHistoryEntry()` 清理流程。

## 自动化补强

1. 新增 `displayViewport` 纯函数单测，覆盖右/下边缘裁剪与越界返回空视口。  
2. 新增 `useGradientTool` 用例：GPU 提交返回 `false` 时，必须回退执行 CPU 提交。

## 经验沉淀

1. 凡是“tile 坐标 -> 屏幕渲染”的路径，必须在最终渲染前做一次基于 render target 的硬裁剪。  
2. GPU history 只要有 `begin/capture`，就必须有对称的 `finalize`，否则撤销链路会退化为隐式 fallback。  
3. 渐变工具是“预览链路 + 提交链路 + 历史链路”三段式，不应只验证视觉正确，还要强制覆盖 undo/redo 行为。

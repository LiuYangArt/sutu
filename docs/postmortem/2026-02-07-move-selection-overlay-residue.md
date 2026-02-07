# Move 工具选区拖拽残留复盘（2026-02-07）

**日期**：2026-02-07  
**状态**：已修复

## 背景

在 Move 工具上线后，用户连续反馈了两个看似相反但同源的问题：

1. 拖拽中，选区原位置被“填回去”（松开后又恢复）。
2. 修复第一轮后，拖拽中又出现“原位置内容残留，松开才消失”。

该问题直接影响选区移动的所见即所得体验，优先级高。

## 现象

1. `move + hasSelection` 时，拖拽过程中主画面与选区预览不一致。  
2. 残留只在拖拽阶段明显，`pointerup` 后最终落盘结果基本正确。  
3. 在 GPU 显示路径开启时更容易复现。

## 根因

根因分两层：

### 根因 A：预览分层职责混淆

在 overlay 预览模式下，`pointerdown` 阶段错误地把“`anchor base + floating source`”同时写回主图层。  
正确模型应该是：

1. 主图层只保留 `anchor base`（被挖空后的底图）。
2. 浮动内容只在 preview overlay 渲染。

职责混淆会导致拖拽时视觉上出现“洞被填回”。

### 根因 B：CPU 合成期间 GPU 画布陈旧帧透出

Move 预览大量走 `forceCpu` 路径，而 GPU canvas 仍可能显示上一个 GPU 帧。  
当主 canvas 的透明区域出现时，会透出旧 GPU 内容，看起来像“原像素残留”。

## 修复方案

### 修复 1：严格分离主图层与预览层

`useMoveTool` 在 overlay 预览初始化时改为：

1. 仅把 `anchor base` 写入主图层。  
2. 浮动源像素仅绘制到 `move-preview-canvas`。

对应改动：`src/components/Canvas/useMoveTool.ts`

### 修复 2：CPU 合成时主动清空 GPU 画布

`Canvas` 的 `compositeAndRender` 在进入 CPU 路径时新增一次性清屏保护：

1. 若当前 GPU 显示激活且本轮走 CPU 合成，先提交一帧空 layer 清空 GPU canvas。  
2. 回到 GPU 路径后重置标记，避免重复清屏。

对应改动：`src/components/Canvas/index.tsx`

## 验证

1. `pnpm -s typecheck`：PASS  
2. `pnpm -s vitest src/components/Canvas/__tests__/useMoveTool.test.ts --run`：PASS  
3. `pnpm -s vitest src/components/Canvas/__tests__ --run`：PASS

## 经验沉淀

1. 选区“浮动移动”必须坚持双层模型：`anchor in base` + `floating in overlay`，不能混写。  
2. 在 GPU/CPU 混合显示架构里，切到 CPU 合成时要显式处理 GPU 背板可见性，否则透明区域会暴露陈旧帧。  
3. 对“拖拽期异常、提交后正确”的问题，优先检查预览管线与最终落盘管线是否复用了不同渲染目标。

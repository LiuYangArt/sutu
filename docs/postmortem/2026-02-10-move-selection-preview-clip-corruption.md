# Move 工具选区拖拽裁切与白块复盘（2026-02-10）

**日期**：2026-02-10  
**状态**：已修复

## 背景

Move Tool 两阶段改造后，`lasso + move` 在拖拽阶段仍有显示异常：选区边缘被裁切、当前图层局部出现白色矩形块；松开鼠标后画面恢复正常。  
问题只在“拖拽预览阶段”出现，最终落盘基本正确，说明问题集中在 move preview 渲染链路。

## 现象

1. 不规则选区（lasso）移动时，边缘像素在拖拽中被截断。  
2. 拖拽过程中当前图层会出现矩形污染/白块，停止拖拽后恢复。  
3. 其他图层通常不受影响，污染集中在 active layer 的预览区域。

## 根因

本次最终确认是两个因素叠加：

### 根因 A：选区边界与掩码栅格扩展不一致

`selectionMask` 在栅格化时存在边缘扩展（`-1/+2`），而 move preview 使用的 `bounds` 是紧包围盒。  
结果是拖拽时边缘像素不在预览处理范围内，表现为“选区边沿裁切”。

### 根因 B：局部 copy 语义破坏预览基线

在 preview 画布局部更新中，使用了 `globalCompositeOperation='copy'` 做脏区回填。  
`copy` 会将目标区域未被源覆盖的部分写成透明，叠加“仅同步 dirty tiles 到 GPU”后，拖拽期会出现矩形污染（视觉上像白块/坏块）。  
这解释了“拖拽中坏、松手后恢复”：提交后 authoritative layer 重同步会覆盖污染。

## 修复方案

### 修复 1：统一选区边界扩展规则

在 move preview 构建阶段对 selection bounds 应用与 mask 同步的边缘扩展，避免边界漏像素。

### 修复 2：禁用局部 `copy`，改回“清脏区 + source-over 重绘”

局部预览回填统一使用：

1. `clearRect(clipRect)` 清理脏区。  
2. `drawImage(source, ...)` 以 `source-over` 回填基线。  
3. 再执行 `destination-out`（挖空）与 floating draw（偏移后绘制）。

这样不会破坏脏区外的预览基线，也不会在 dirty tile 上传时引入矩形透明污染。

### 修复 3：扩大 selection move 脏区 padding

将 selection 预览脏区扩展从 `2` 提升到 `4`，覆盖 AA/插值边缘，减少快拖时边沿截断。

## 涉及代码

1. `src/components/Canvas/useMoveTool.ts`  
2. `src/components/Canvas/__tests__/useMoveTool.test.ts`

## 验证

1. `pnpm -s vitest src/components/Canvas/__tests__/useMoveTool.test.ts --run --reporter=verbose`  
2. `pnpm -s vitest src/components/Canvas/__tests__/movePreviewGpuSync.test.ts src/utils/__tests__/layerRenderer.movePreviewBlend.test.ts --run --reporter=verbose`  
3. `pnpm -s typecheck`  
4. `pnpm -s playwright test e2e/move-tool.spec.ts`

以上均通过。

## 经验沉淀

1. **局部重绘禁用 `copy` 作为默认手段**：除非能保证“该目标区域每个像素都被完整重写”，否则会引入透明污染。  
2. **dirty rect 要覆盖 AA 边缘**：选区/软边内容不能只按几何边界算脏区，必须预留 padding。  
3. **“拖拽异常、提交恢复”优先看预览链路**：尤其检查 preview canvas 局部更新与 GPU tile 增量同步的组合语义。  
4. **为渲染语义写回归测试**：不仅测功能结果，还要测“清理方式/调用顺序/脏区范围”。

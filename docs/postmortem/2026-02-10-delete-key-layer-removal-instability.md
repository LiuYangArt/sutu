# Del 键删除图层偶发失效复盘（2026-02-10）

**日期**：2026-02-10  
**状态**：已修复

## 背景

需求语义是：

1. 有选区时，`Del` 删除选区内像素。  
2. 无选区时，`Del` 删除当前图层（非背景层）。

用户反馈“删除图层不能稳定触发，偶发按键无效”。

## 现象

1. `Del` 的事件分支已进入（无输入框焦点、无修饰键）。  
2. 在“无选区 + 当前图层可删”的前提下，偶发没有删除动作。  
3. 同一会话中重试有时成功、有时失败，具备竞态特征。

## 根因

`__canvasRemoveLayer` 最终调用 `useLayerOperations.handleRemoveLayer`。  
该回调之前依赖闭包中的 `layers` 参数来查找 `layerState/layerIndex`。

在 React 状态更新时，可能出现以下窗口期：

1. Document store 中 `layers` 已更新。  
2. `handleRemoveLayer` 仍是旧闭包，持有旧 `layers`。  
3. 用旧数组查找当前 `layerId` 失败，函数提前 `return`。  

因此表现为“Del 有时删得掉，有时没反应”。

## 修复方案

### 修复 1：删除路径改为读取实时 store

`handleRemoveLayer` 改为每次从 `useDocumentStore.getState().layers` 获取最新图层数据，消除闭包陈旧数据导致的提前返回。

### 修复 2：等价简化查找逻辑（code-simplifier）

将 `find + findIndex` 双遍历简化为单次 `findIndex`，再通过索引读取 `layerState`，在不改变行为前提下减少分支复杂度。

### 修复 3：新增回归测试锁定竞态场景

新增测试刻意构造“hook 传入旧 `layers`，但 store 已更新”的场景，验证删除仍成功，避免回归。

## 涉及代码

1. `src/components/Canvas/useLayerOperations.ts`  
2. `src/components/Canvas/__tests__/useLayerOperations.removeLayer.test.ts`

## 验证

1. `pnpm -s vitest run src/components/Canvas/__tests__/useLayerOperations.removeLayer.test.ts`  
2. `pnpm -s vitest run src/components/Canvas/__tests__/useKeyboardShortcuts.test.ts src/components/Canvas/__tests__/useGlobalExports.test.ts`  
3. `pnpm -s typecheck`

以上均通过。

## 经验沉淀

1. 全局快捷键链路不要依赖 React 闭包快照做关键校验，优先读取 authoritative store 实时状态。  
2. “偶发成功/偶发失败”优先按竞态排查：事件触发稳定但动作缺失，通常是陈旧状态或异步窗口期。  
3. 对快捷键问题应补“旧闭包 vs 新状态”类回归用例，而不只测正常路径。  

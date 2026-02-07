# M5 布尔选区提交卡顿复盘（2026-02-07）

**日期**：2026-02-07  
**状态**：已修复

## 背景

M5 收尾手测阶段，用户在大画布（如 `5000x5000`）下反馈：

1. 新建选区性能已明显改善。  
2. 但布尔选区（`add/subtract/intersect`）在“完成选区”瞬间仍有明显卡顿。  

该问题会影响选区工具连续操作手感，属于交互链路的高优先级体验问题。

## 现象

1. 在 lasso / selection 完成布尔选区时，pointer up 后主线程出现短暂停顿。  
2. 画布越大、路径越复杂，卡顿越明显。  
3. 卡顿阶段常与以下工作叠加：
   - 路径栅格化；
   - base/new mask 布尔合成；
   - 从 mask 反推轮廓（蚂蚁线路径）。

## 根因

布尔选区提交路径仍是主线程同步重计算：

1. `commitSelection()` 布尔分支内同步执行 `pathToMask + combineMasks + traceMaskToPaths`。  
2. 该链路在大分辨率与复杂路径场景下计算量过大，阻塞主线程渲染与输入事件处理。  
3. 虽然“新建选区”已异步化，但布尔分支未同步迁移，形成性能短板。

## 修复方案

### 1) 布尔提交异步化（worker 优先）

在 `selectionMask.worker` 增加 `commit_boolean_selection` 请求，worker 内完成：

1. 新路径局部栅格化；  
2. 布尔合成（`add/subtract/intersect`）；  
3. 由最终 mask 追踪轮廓路径。  

主线程仅负责发起请求与回填最终状态。

### 2) 交互优先策略

`commitSelection()` 布尔分支改为：

1. 立即清理创建态（不阻塞 UI）；  
2. 先置 `selectionMaskPending=true`；  
3. 下一帧后再提交 worker 计算（让蚂蚁线/界面先响应）。  

### 3) 可靠回退

当 worker 不可用或失败时，自动回退到旧的主线程路径，保证功能可用性。

### 4) 历史一致性修正

`SelectionSnapshot` 增加 `selectionMaskPending`，并更新 `didSelectionChange`，避免异步阶段历史记录遗漏。

## 验证

1. `pnpm -s typecheck`：PASS  
2. `pnpm -s test -- selection.commit selection.snapshot history.selection useKeyboardShortcuts useSelectionHandler`：PASS  
3. `pnpm -s test`：PASS（全量）

## 经验沉淀

1. 选区链路必须“全路径异步化”，不能只优化新建分支。  
2. 大画布下，`mask 布尔合成 + 轮廓追踪` 是典型的主线程热点，应默认下沉 worker。  
3. 交互体验优化优先级应为：
   - 先让 UI 状态立即返回；
   - 再异步回填精确像素结果。  
4. 异步化改造时，`pending` 状态要纳入历史快照，否则容易出现撤销语义漂移。

## 关联问题

`difference` 与 Photoshop 一致性差异已单独记录并延期，不阻塞本项收尾：  
`docs/postmortem/2026-02-07-m5-difference-photoshop-parity-gap.md`

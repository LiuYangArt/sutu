# 图层面板 Overlay 定位与裁剪问题复盘（2026-02-10）

**日期**：2026-02-10  
**状态**：已修复

## 背景

本轮图层功能增强后，用户反馈两个可见性问题：

1. `F2` 批量重命名弹窗没有居中，而是“挤”在右侧图层面板区域。  
2. 图层右键菜单在部分场景下完全不出现（包括图层项和列表空白区）。

## 现象

1. 弹窗样式看似 `position: fixed`，但视觉上跟随右侧面板而不是跟随视口。  
2. 右键事件能触发（测试可过），但 UI 上没有菜单，表现为“像是没弹出”。  
3. 在右侧 SidePanel（固定定位 + 毛玻璃）结构下更容易复现。

## 根因

核心是 **Overlay 渲染层级错误**：

1. 右键菜单和重命名弹窗最初都渲染在 `LayerPanel` 组件树内部。  
2. 该组件位于右侧容器中，父级存在 `backdrop-filter` 与 `overflow: hidden`。  
3. 在该上下文里，面板内 `position: fixed` 子元素会受到父级裁剪/坐标系影响，导致：
   - 弹窗看起来被“吸附”在右侧区域；
   - 右键菜单可能被裁掉，视觉上等同“没有弹出”。

## 修复方案

### 修复 1：Overlay 全部 Portal 到 `document.body`

将以下 UI 从面板内部渲染改为 `createPortal(..., document.body)`：

1. 图层右键菜单  
2. `F2` 重命名弹窗

这样直接脱离右侧面板的裁剪和局部坐标系。

### 修复 2：菜单视口边界钳制

新增 `clampContextMenuPosition`，在靠近窗口边缘右键时限制菜单坐标，避免菜单部分跑出屏幕。

### 修复 3：补齐列表空白区右键入口

`layer-list` 增加 `onContextMenu`，允许在空白区唤起同一菜单；上下文图层采用“选中优先、激活兜底”的策略。

### 修复 4：code-simplifier 清理（不改行为）

针对本次图层改造代码做了可读性清理：

1. 抽取 `getNextLayerName`，去重多处新建图层命名逻辑。  
2. 抽取 `resolveContextMenuLayerId` 和 `openContextMenuAt`，去重右键菜单开关逻辑。  
3. 抽取批量属性应用公共路径（受保护层跳过统计 + toast），去重 opacity/blend 的重复分支。

## 涉及代码

1. `src/components/LayerPanel/index.tsx`  
2. `src/components/LayerPanel/LayerPanel.css`  
3. `src/components/LayerPanel/__tests__/LayerPanel.multiSelect.test.tsx`

## 验证

1. `pnpm -s typecheck`  
2. `pnpm -s vitest src/components/LayerPanel/__tests__/LayerPanel.multiSelect.test.tsx --run`

## 经验沉淀

1. **所有菜单/弹窗/浮层都应默认 Portal 到 `document.body`**，不要依赖局部面板内的 `fixed`。  
2. 当父级使用 `backdrop-filter`、`transform`、`overflow` 时，要优先怀疑 overlay 裁剪与定位上下文问题。  
3. 右键功能必须同时覆盖“项上右键 + 空白区右键”，并补自动化用例防回归。  
4. 对批量操作逻辑做小步抽象（公共 helper）可以显著降低重复分支，减少后续改动时的漏改风险。

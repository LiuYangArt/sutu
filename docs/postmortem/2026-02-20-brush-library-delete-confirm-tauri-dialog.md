# Brush Library 删除确认失效复盘（2026-02-20）

**日期**：2026-02-20  
**状态**：已修复

## 背景

Brush Library 出现两个用户可见问题：

1. 面板标题显示为 `Title`，未显示预期的 `Brush Library`。
2. 删除单个笔刷、删除整组笔刷时，用户反馈“还没点确认就已经删除”。

## 现象

1. 英文环境打开 Brush Library，标题显示固定文案 `Title`。
2. 点击删除按钮后，即使用户主观上还未完成确认交互，删除动作已发生。
3. 该问题在单个删除和整组删除两条路径都可复现。

## 根因

1. i18n 配置错误：`en-US` 中 `brushLibrary.title` 被错误配置为 `Title`。
2. 交互实现风险：删除确认使用 `window.confirm`。在 Tauri/WebView 场景下，该 API 的交互体验与时序稳定性不如原生对话框，导致用户感知为“确认前已删除”。

## 修复方案

### 修复 1：标题文案修正

将 `src/locales/en-US.json` 中 `brushLibrary.title` 从 `Title` 改为 `Brush Library`。

### 修复 2：删除确认改为 Tauri 原生确认框

将 Brush Library 的两条删除路径从 `window.confirm` 切换为 `@tauri-apps/plugin-dialog` 的 `confirm()`：

1. 删除单个笔刷：`handleDelete`
2. 删除整组笔刷：`handleDeleteGroup`

并统一为 `warning` 类型，确保操作语义明确。

### 修复 3：i18n 补齐删除预设文案

新增 `brushLibrary.confirm.deletePreset`，并在 `en-US` 与 `zh-CN` 同步补齐，避免单语 key 漏洞。

## 涉及代码

1. `src/components/BrushLibrary/BrushLibraryPanel.tsx`
2. `src/locales/en-US.json`
3. `src/locales/zh-CN.json`

## 验证

1. `pnpm -s typecheck` 通过。
2. 手动回归：
   1. 删除单个笔刷时点击“取消”，笔刷不删除；点击“确认”才删除。
   2. 删除分组时点击“取消”，分组不删除；点击“确认”才删除。
   3. 英文环境标题显示 `Brush Library`。

## 经验沉淀

1. 在 Tauri 桌面端，涉及破坏性操作的确认弹窗优先使用 `@tauri-apps/plugin-dialog`，避免依赖 `window.confirm` 的平台差异行为。
2. i18n 变更应同步检查核心入口文案（如标题），防止默认占位词进入正式 UI。
3. 删除类操作应坚持“确认结果返回后再执行副作用”的结构，并尽量集中复用确认逻辑，减少未来漏改概率。

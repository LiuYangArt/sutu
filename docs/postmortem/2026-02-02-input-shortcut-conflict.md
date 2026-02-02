# 输入框快捷键冲突修复

**日期**: 2026-02-02
**问题**: 搜索框中无法输入已绑定快捷键的字母

## 问题描述

在 Pattern Library 和 Brush Settings 的搜索框中输入文字时，已绑定工具快捷键的字母（如 `B`=笔刷、`E`=橡皮擦）无法正常输入，因为这些按键被快捷键系统拦截。

## 根因分析

`Canvas/index.tsx` 中的键盘事件处理缺少输入框焦点检查。相比之下，`App.tsx` 中的 `handleDrawingShortcuts` 已有类似检查（第 112-115 行），但 Canvas 组件的工具快捷键处理遗漏了这一点。

**问题代码位置**: `src/components/Canvas/index.tsx` 第 1614-1727 行

## 解决方案

在 Canvas 键盘事件处理函数开头（Ctrl 组合键处理之后）添加输入框焦点检查：

```typescript
// Skip tool shortcuts if focus is on input elements (e.g., search boxes)
// Allow Ctrl/Meta combos (handled above) and ESC to work normally
if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
  return;
}
```

**设计决策**:

- 检查放在 Ctrl 组合键处理之后，确保 Undo/Redo/Select All 在输入框中仍可用
- 仅检查 `HTMLInputElement` 和 `HTMLTextAreaElement`，不含 `contenteditable`（当前项目未使用）

## 影响范围

涉及所有包含文本输入的 UI 组件：

- Pattern Library 搜索框
- Brush Settings → Pattern Picker 搜索框
- Layer Panel 图层重命名
- Color Panel Hex 输入
- 其他 `<input type="text">` 元素

## 经验总结

1. **快捷键系统需要全局上下文感知**: 工具快捷键应在设计时就考虑输入框焦点场景
2. **一致性检查**: `App.tsx` 已有输入框检查，Canvas 组件也应保持一致
3. **测试覆盖**: 可考虑添加集成测试验证快捷键在输入框中不触发

## 验证

- `pnpm check:all` 全部通过
- 手动测试：Pattern Library / Pattern Picker 搜索框可正常输入 "b"、"e" 等字母

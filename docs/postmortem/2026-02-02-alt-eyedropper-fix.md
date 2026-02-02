# Alt 吸色工具失效修复

**日期**: 2026-02-02
**问题**: 画笔工具按住 Alt 键无法切换到吸色工具
**状态**: 已修复

## 问题描述

使用画笔工具时，按住 Alt 键应临时切换到吸色工具（eyedropper），松开后恢复画笔。此功能突然失效，但 Lasso 工具的 Alt/Shift/Ctrl 修饰键仍正常工作。

## 根因分析

### 现象追踪

添加调试日志后发现关键线索：

```
[handleKeyDown ENTRY] Alt detected: AltLeft currentTool: brush
[DEBUG] ctrlKey: false metaKey: false repeat: true  ← 问题关键！
[DEBUG] Alt blocked by e.repeat check
```

**`e.repeat: true`** 说明主 handler 只收到了重复按键事件，首次按键（`repeat: false`）被其他监听器拦截了。

### 代码结构问题

`Canvas/index.tsx` 中存在**两个独立的 `keydown` 事件监听器**：

```
┌─────────────────────────────────────────────────────────────┐
│  Effect 1 (第 206-240 行)                                    │
│  - 依赖数组: []                                              │
│  - 先注册，先收到事件                                         │
│  - 只设置 setAltPressed(true)，不切换工具                     │
│  - 使用 !e.repeat 过滤，只处理首次按键                         │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  Effect 2 (第 1636-1765 行)                                  │
│  - 依赖数组: [currentTool, setTool, ...]                     │
│  - 后注册，收到第二手事件                                     │
│  - 包含 Alt 吸色切换逻辑                                      │
│  - 代码: if (e.repeat && !isBracket) return; ← 阻止了 Alt    │
└─────────────────────────────────────────────────────────────┘
```

**问题**：Effect 1 消费了首次按键（`repeat: false`），Effect 2 只收到重复事件（`repeat: true`），被 repeat 检查拦截。

### 为什么 Lasso 工具正常？

Lasso 工具的 Alt 处理在 `useSelectionHandler.ts` 中，它有自己独立的 `useEffect` 监听器，且使用 `altPressedRef`（ref 而非 state）来实时追踪按键状态，不依赖事件的 `repeat` 属性。

## 修复方案

将 Alt 吸色切换逻辑移到 **Effect 1** 中（首次捕获事件的地方）：

```typescript
// Effect 1: Keyboard event listeners for modifiers
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !e.repeat) setSpacePressed(true);

    // Alt key: switch to eyedropper for brush/eraser tools
    if ((e.code === 'AltLeft' || e.code === 'AltRight') && !e.repeat) {
      const tool = useToolStore.getState().currentTool;
      if (tool === 'brush' || tool === 'eraser') {
        e.preventDefault();
        setAltPressed(true);
        previousToolRef.current = tool;
        useToolStore.getState().setTool('eyedropper');
      }
    }
  };

  const handleKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') setSpacePressed(false);

    // Release Alt: restore previous tool
    if (e.code === 'AltLeft' || e.code === 'AltRight') {
      setAltPressed(false);
      const tool = useToolStore.getState().currentTool;
      if (previousToolRef.current && tool === 'eyedropper') {
        useToolStore.getState().setTool(previousToolRef.current);
        previousToolRef.current = null;
      }
    }
  };
  // ...
}, []);
```

关键点：

- 使用 `useToolStore.getState()` 直接读写，避免闭包陈旧问题
- 复用已有的 `previousToolRef`
- 移除 Effect 2 中的重复 Alt 处理代码

## 经验教训

### 1. 多个事件监听器的顺序问题

当同一页面有多个 `window.addEventListener('keydown', ...)` 时，**注册顺序决定执行顺序**。使用 `e.repeat` 过滤时需考虑其他监听器可能先消费首次事件。

### 2. 调试技巧：从入口开始追踪

本次调试策略：

1. 在函数入口添加日志 → 确认事件到达
2. 检查关键属性值 → 发现 `repeat: true`
3. 追踪 repeat 来源 → 定位到 Effect 1

### 3. 参考工作代码

Lasso 工具的 Alt 处理使用 ref 而非依赖 `e.repeat`，更健壮：

```typescript
const altPressedRef = useRef(false);

// keydown
altPressedRef.current = true;

// 使用时直接读取 ref
const isAltMode = altPressedRef.current;
```

### 4. Postmortem 文档价值

本次修复过程中，`m4-selection-lasso.md` 文档提供了关键线索——它记录了类似的 Alt 键冲突问题（Alt 全局切换吸色工具 vs Lasso 的 polygonal 模式），帮助快速定位问题方向。

## 修改文件

- `src/components/Canvas/index.tsx`: 将 Alt 吸色切换逻辑移至独立 hook
- `src/components/Canvas/useAltEyedropper.ts`: **NEW** - 封装 Alt 吸色切换逻辑
- `src/components/Canvas/__tests__/useAltEyedropper.test.ts`: **NEW** - 8 个单元测试
- `src/gpu/GPUStrokeAccumulator.ts`: 删除未使用的 `_getLastBatchUnionRect` 方法

## 防止 Regression：单元测试

新增 `useAltEyedropper.test.ts` 覆盖以下场景：

| 测试用例               | 验证点                   |
| ---------------------- | ------------------------ |
| brush 工具按 Alt       | 应切换到 eyedropper      |
| eraser 工具按 Alt      | 应切换到 eyedropper      |
| lasso 工具按 Alt       | 应**不**切换（保持原样） |
| 松开 Alt               | 应恢复原工具             |
| e.repeat: true         | 应忽略重复事件           |
| AltRight 支持          | 左右 Alt 均有效          |
| 手动切换工具后松开 Alt | 不应恢复                 |
| unmount 时             | 应清理事件监听器         |

## 相关文档

- [m4-selection-lasso.md](./m4-selection-lasso.md) - Lasso 工具的 Alt 键处理经验

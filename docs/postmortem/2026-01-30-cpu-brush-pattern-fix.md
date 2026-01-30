# CPU 笔刷纹理失效问题分析

**日期**: 2026-01-30
**相关模块**: `StrokeAccumulator`, `MaskCache`, `TextureMaskCache`, `useToolStore`

## 1. 问题描述

用户反馈在使用默认圆头笔刷（Procedural Brush）时，即使在 UI 上开启了 "Texture" 开关并选择了图案（Pattern），画出的笔触依然没有纹理效果。然而，如果是通过 ABR 导入的笔刷（本身带有纹理），则可以正常应用和切换图案。

## 2. 根本原因分析 (Root Cause Analysis)

经过排查，问题出在**状态管理的冗余**与**渲染逻辑的判断条件**不一致。

### 2.1 状态冗余 (State Redundancy)

在 `TextureSettings` 接口中存在一个 `enabled` 字段：

```typescript
export interface TextureSettings {
  enabled: boolean; // <--- 冗余字段
  patternId: string | null;
  // ...
}
```

同时，全局 `useToolStore` 中也有一个控制 UI 开关的 `textureEnabled` 状态。

### 2.2 数据不同步 (Data Desynchronization)

对于默认笔刷，其初始 `textureSettings` 为 null 或默认对象（其中 `enabled: false`）。
当用户点击 UI 上的 "Texture" 复选框时，更新的是 `useToolStore.textureEnabled`。虽然逻辑上这应该激活纹理，但并未同步更新 `textureSettings.enabled` 为 `true`。

### 2.3 渲染逻辑缺陷 (Logic Flaw)

在渲染管线（`strokeBuffer.ts`, `maskCache.ts`）中，判断是否应用纹理的逻辑错误地依赖了内部字段：

```typescript
// 错误代码
if (textureSettings && textureSettings.enabled && pattern) {
  // Apply texture...
}
```

由于 `textureSettings.enabled` 仍然是默认为 `false`，导致即使 `textureSettings` 对象被传递进来了（说明 UI 是开启的），渲染循环依然跳过了纹理处理。

**为什么 ABR 笔刷能工作？**
ABR 导入的笔刷在解析时，可能构建了一个 `enabled: true` 的 `TextureSettings` 对象，或者其初始化路径与默认笔刷不同，侥幸绕过了这个问题。

## 3. 解决方案 (Solution)

**核心原则**: **单一事实来源 (Single Source of Truth)**。

既然 `strokeBuffer.ts` 的 `stampDab` 方法只有在 UI 开启纹理时才会接收到 `textureSettings` 对象（由调用方根据 store 状态决定传参），那么**只要接收到了非空的 `textureSettings` 对象，就应该视为启用**。内部的 `enabled` 字段是多余且不可靠的。

### 3.1 代码变更

移除了所有渲染底层对 `.enabled` 的检查，改为检查对象存在性与必要数据（`patternId`）：

```typescript
// 修正后 (src/utils/maskCache.ts 等)
if (textureSettings && pattern) {
  // Apply texture...
}
```

### 3.2 额外优化 (Refactoring)

在修复 Bug 的同时，执行了代码简化工作：

1.  **统一混合逻辑**: 将 `TextureMaskCache` 中的内联混合代码提取为 `blendPixel` 私有方法，保持与 `MaskCache` 的一致性，便于未来维护。
2.  **清理代码**: 移除了未使用的 `PatternData` 类型导入。
3.  **语法简化**: 使用 Optional Chaining (`?.`) 简化了 `strokeBuffer.ts` 中的图案获取逻辑。

## 4. 经验教训 (Lessons Learned)

1.  **避免状态冗余**: 在设计数据结构时，尽量避免在嵌套对象中存储与父级控制状态重复的标志位。如果必须存储，必须确保严格的双向绑定。
2.  **防御性编程**: 在渲染底层，对于通过参数传递进来的配置对象，应优先信任 "对象存在即启用" 的隐式契约，而不是去验证可能过时或不同步的内部标志位。
3.  **一致性**: `MaskCache` 和 `TextureMaskCache` 作为这一层级的两个核心类，其内部实现细节（如混合算法）应尽量保持结构一致，避免维护时的认知分裂。

# Unified Timeline History System

## Problem

图层撤销系统存在多个问题：

1. 新建图层无法撤销
2. 撤销时笔触恢复到错误图层
3. 跨图层操作后撤销混乱
4. 删除图层后历史中仍有该图层的操作，导致 undo 被阻塞

## Root Cause Analysis

### 第一性原理分析

原始架构问题：

- `HistoryEntry` 只存储 `imageData`，不含 `layerId`
- 保存操作**后**的状态而非操作**前**的状态
- 缺少操作类型区分（stroke/addLayer/removeLayer）
- 图层删除未记录到历史

## Solution

### 参考 Krita 架构

分析 Krita 源码发现其使用 **Command 模式**：

- 每个操作是独立的 `KUndo2Command` 对象
- 图层删除保留完整节点引用，undo 时恢复整个节点
- 笔触操作绑定到图层节点

### 我们的实现

**统一时间线历史系统**：

```typescript
type HistoryEntry =
  | { type: 'stroke'; layerId: string; beforeImage: ImageData; afterImage?: ImageData }
  | { type: 'addLayer'; layerId: string; layerMeta: Layer; layerIndex: number }
  | {
      type: 'removeLayer';
      layerId: string;
      layerMeta: Layer;
      layerIndex: number;
      imageData: ImageData;
    };
```

**关键改动**：

1. `beforeImage` 在笔触**开始**时保存
2. `afterImage` 在 undo 时填充，供 redo 使用
3. 图层创建/删除也入栈
4. undo 时检测图层是否存在，不存在则自动递归跳过

## Lessons Learned

1. **保存时机很重要**：必须在操作前保存状态，而非操作后
2. **统一时间线 vs 分图层历史**：统一时间线更符合用户直觉，但需要处理图层删除后的无效操作
3. **参考成熟项目**：Krita 源码提供了宝贵的架构参考
4. **自动跳过无效操作**：作为兜底机制处理边界情况

## Files Modified

- `src/stores/history.ts` - 重写为三种操作类型
- `src/components/Canvas/index.tsx` - 完整 undo/redo 逻辑 + `__canvasRemoveLayer` 接口
- `src/components/LayerPanel/index.tsx` - 通过 Canvas 接口删除图层

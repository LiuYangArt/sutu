# CPU 画笔预览同步与 Dual Brush 漂移问题复盘

## 问题背景

CPU 画笔用于提供 ground truth 参考，与 GPU 笔刷对齐视觉效果。用户反馈：

1. 画一笔时预览呈现“四个 dab 一跳”的刷新节奏，明显卡顿。
2. Dual Brush 的副笔刷使用纹理时出现方块接缝，且已画笔触明暗会随画笔移动持续变化直到结束。

## 现象

- CPU 画笔预览刷新频率过低，视觉上形成批量“组块”更新。
- Dual Brush 在预览阶段出现接缝与亮度漂移（同一笔触区域亮度多次变化）。

## 根因分析

1. **预览节流过强**
   - `StrokeAccumulator.SYNC_INTERVAL = 4`，只在每 4 个 dab 才同步到画布。
   - 造成“4 dab 一跳”的可见刷新节奏。

2. **Dual Brush 预览同步区域不完整**
   - `dualMaskAccumulatorDirty` 只累积不参与同步区域计算。
   - secondary 超出 primary 的区域未被预览刷新，形成接缝。

3. **Dual Brush 预览混合非幂等**
   - `applyDualBrushBlend()` 在每次同步时直接改写 `bufferData` 的 alpha。
   - 同一像素被多次缩放，产生亮度漂移。

## 修复方案

- **CPU 预览同步改为每 dab**
  - `SYNC_INTERVAL = 1`，确保实时预览。
- **合并 primary/secondary dirty rect**
  - `syncPendingToCanvas()` 采用 `pendingDirtyRect ∪ dualMaskAccumulatorDirty`。
- **Dual Brush 与 Wet Edge 仅作用于预览副本**
  - 混合逻辑改为处理 `ImageData` 预览区域，不再改写 `bufferData`。

## 结果

- CPU 画笔预览由“4 dab 一跳”变为连续输出。
- Dual Brush 纹理接缝消失，亮度漂移停止。

## 遗留风险（记录，不在本次修复中处理）

1. **最终合成区域可能仍裁剪 secondary**
   - `endStroke()` 仍以 `dirtyRect`（primary）裁剪合成区域。
   - 若 secondary 超出 primary，可能出现“预览可见、落笔被裁剪”的风险。

2. **测试覆盖不足（已补）**
   - 之前缺少 `StrokeAccumulator` 相关单元测试。
   - 本次补充了预览同步与 dual blend 幂等性测试。

## 经验总结

1. Ground truth 路径必须优先保证“可见正确性”，性能节流可后置。
2. Dual Brush 的预览处理必须幂等，避免对持久 buffer 的累计修改。
3. dirty rect 必须覆盖所有视觉来源（primary + secondary），否则会出现可见接缝。

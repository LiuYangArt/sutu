# GPU Dual Brush 预览闪烁（Preview Update Rect）

## 背景

GPU compute shader 笔刷在笔刷尺寸较大、快速绘制、开启 Dual Brush 时，绘制过程中偶发方块闪烁/白洞。最终落笔结果通常正确，问题集中在 **预览层**。

## 现象

- 闪烁多发生在画布边缘附近。
- 开启 Dual Brush 后更容易触发。
- 关闭 Dual Brush 基本不出现。

## Debug 过程与证据

1. 开启调试矩形：
   - 绿框：`combined-dirty`
   - 红框：`primary-batch`
   - 蓝框：`dual-batch`
   - 黄框：`preview-update`（updatePreview 实际 putImageData 的区域）

2. 观察到：
   - 闪烁集中出现在 **黄框边缘**。
   - 黄框使用 `combined-dirty` 时在边缘明显过大。

3. 切换到 batch union 后：
   - Console：`window.__gpuBrushUseBatchUnionRect = true`
   - 闪烁现象消失（至少在当前测试中不再复现）。

## 初步结论（根因）

`updatePreview()` 使用 `combined-dirty` 作为读回与 putImageData 的区域，导致读回区域过大且在边缘被 clamp，
在 Dual Brush 高负载时更易出现 **预览更新滞后/边缘空洞**。

## 解决方案 A（已实施）

**目标：只修预览闪烁，不动 dual blend 计算范围。**

- 预览更新改用 **batch union**（primary/dual batch bbox 的 union）。
- 引入 `pendingPreviewRect`，在多次 flush 时累积需要更新的区域。
- 只有在 applyDualBlend 后触发 preview 更新（Dual Brush 时）。
- Dual blend 仍使用 `combined-dirty`（保持保守正确性）。
- 可用 Console 切回 `combined-dirty`：
  - `window.__gpuBrushUseBatchUnionRect = false`

## 方案 B（备选，未实施）

**进一步优化性能：dual blend 也改用 batch union。**

- applyDualBlend 也只处理 batch union，而非 combined-dirty。
- 潜在收益：减少 compute 区域，降低 GPU 压力。
- 风险：如果 dual blend 在边缘存在跨区域依赖（目前看是像素级无邻域依赖），可能出现漏更。
- 建议：若后续性能仍不足或有新问题，再开启方案 B 并对比验证。

## 状态

- A 方案：已实施。
- B 方案：记录待评估。

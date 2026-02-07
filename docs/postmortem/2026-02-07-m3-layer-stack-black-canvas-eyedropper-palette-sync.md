# M3 多图层 GPU 合成：黑屏、吸色与调色板不同步复盘（2026-02-07）

**日期**：2026-02-07  
**状态**：已修复

## 背景

在 M3 最小闭环（多图层 GPU 显示合成 + 4 种 blend）落地后，连续暴露了三类问题：

1. 画布不显示（仅图层缩略图可见）。  
2. `multiply/screen/overlay` 图层在可见性切换后，画布偶发整屏发黑。  
3. 吸色器与“所见即所得”不一致，且调色板光标不随吸色结果同步。

这些问题都发生在“多图层 GPU 显示路径 + 吸色交互”交界处，属于典型的跨模块时序与状态一致性问题。

## 现象与根因

### 问题 1：画布不显示（GPUValidationError）

**现象**  
- 控制台报错：`CommandEncoder ... locked while RenderPassEncoder ... is open`。  
- 画一笔时图层缩略图会更新，但主画布不出图。

**根因**  
- `renderLayerStackFrame()` 先开启 display pass；  
- 循环内又调用 blend/composite pass，在同一 `GPUCommandEncoder` 上二次 `beginRenderPass`；  
- 形成 pass 嵌套，导致 command buffer 失效并触发连锁 `Invalid CommandBuffer`。

**修复**  
- display pass 改为“每 tile 合成完成后单独开关一次”（首个 clear，后续 load）。  
- 先确保 pass 生命周期合法，再提交 encoder。

---

### 问题 2：可见性切换后整屏发黑（非 normal blend）

**现象**  
- 图层为 `multiply` 等非 normal 模式时，隐藏再显示后画布可能整体变黑。

**根因 A（数学）**  
- `tileLayerBlend.wgsl` 的合成公式缺少 `src * (1 - dstAlpha)` 项；  
- 在透明/半透明底图上会错误压暗，放大为整屏发黑。

**根因 B（数据）**  
- layer blend pass 共用同一个 16B uniform 槽位；  
- 同一 submit 内多次 `writeBuffer` 互相覆盖，前序 pass 读取到后序 blendMode/opacity。

**修复**  
- 按 Porter-Duff `source-over` + blend mode 重写 RGB 组合公式；  
- layer blend uniform 改为“按 pass 分配独立 offset（动态扩容）”，避免覆盖。

---

### 问题 3：吸色与所见不一致，调色板光标不更新

**现象**  
- 隐藏图层后仍可吸到隐藏层颜色；透明区吸到黑色；  
- 前景色方块变了，但上方调色板指示点（S/V、H）不跟随。

**根因 A（采样源错误）**  
- GPU 吸色路径按 active layer 单层采样，不是最终可见合成结果；  
- `alpha=0` 时直接回退黑色，违反“看到什么采什么”。

**根因 B（UI 状态同步）**  
- `ColorPanel` 用 `lastInitiatedHex` 抑制回环更新；  
- 标记未及时清除时，外部更新（如吸色）可能被误判为本地回环，导致 HSVA 不同步。

**修复**  
- GPU 吸色改为：先同步 pending GPU->CPU，再从 composite 结果采样；  
- `alpha=0` 不改色（返回 `null`），避免透明区吸黑；  
- `ColorPanel` 回环抑制改为 one-shot（命中后立即清空标记），保证外部更新可驱动 HSVA。

## 验证结果

- `pnpm -s typecheck`：PASS  
- `pnpm -s test`：PASS（224 tests）

手工回归结论：  
- 多图层显示恢复正常，无 pass 嵌套报错；  
- 非 normal blend 图层可见性切换不再整屏发黑；  
- 吸色符合“所见即所得”，透明区不再吸黑；  
- 调色板光标可随吸色结果同步。

## 经验沉淀

1. **同一 encoder 禁止 pass 嵌套**：先定生命周期，再谈缓存/性能。  
2. **每个 pass 的 uniform 必须有独立快照**：`writeBuffer` 在 submit 前是可覆盖的。  
3. **blend + alpha 不能只看 RGB 插值**：透明项缺失会在非 normal 模式下放大成全局错误。  
4. **吸色语义必须绑定“最终可见结果”**：不能偷懒采 active layer。  
5. **UI 回环抑制要一次性**：防抖 token 不清理会把后续外部同步误杀。

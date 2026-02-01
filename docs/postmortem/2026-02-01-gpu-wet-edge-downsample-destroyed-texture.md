# 2026-02-01 GPU Wet Edge + Downsample Destroyed Texture Postmortem

## 1. Summary

GPU 纹理笔刷开启 Wet Edge 且使用超大笔刷时，出现 WebGPU 报错 “Destroyed texture used in a submit”。根因是 Downsample (render scale) 变化触发 PingPong 纹理重建，但 Wet Edge compute 管线未同步更新尺寸导致 BindGroup 缓存继续引用已销毁纹理。修复方式是在 render scale 变化时同步更新 Wet Edge 管线尺寸并清理其缓存。

## 2. Issue

**现象**:
- GPU 纹理笔刷 + Wet Edge + 超大笔刷时，控制台报错：
  - `Destroyed texture ["PingPong Texture A/B"] used in a submit`

**触发条件**:
- `Downsample = Auto` 且 `brush size > 300`、`hardness < 70` 导致 render scale 切换。
- 关闭 Downsample 或提高硬度后问题消失。

**范围**:
- GPU 渲染路径，Wet Edge 开启时更容易触发。

## 3. Root Cause

- render scale 变化时会调用 `PingPongBuffer.setRenderScale()`，内部销毁并重建 `PingPong Texture A/B`。
- Wet Edge compute 管线内部有 BindGroup 缓存，Key 仅依赖纹理 label。
- 在 `syncRenderScale()` 中没有同步调用 `wetEdgePipeline.updateCanvasSize()`，导致缓存未清理并继续引用已销毁纹理。
- 当 Wet Edge dispatch 发生时，提交队列引用到已销毁纹理，从而触发 WebGPU validation error。

## 4. Solution

在 render scale 变化分支中补充：
- `wetEdgePipeline.updateCanvasSize(pingPongBuffer.textureWidth, pingPongBuffer.textureHeight)`
- 使 Wet Edge pipeline 清理 BindGroup 缓存，确保使用新纹理。

## 5. Verification

- Downsample=Off 时不再出现报错。
- 修复后在 Downsample=Auto + 超大笔刷 + Wet Edge 场景下不再复现。

## 6. Lessons Learned

1. render scale 变更会重建 GPU 纹理，所有依赖管线必须同步更新并清缓存。
2. BindGroup 缓存 Key 仅依赖 label 容易隐藏“重建但同名”的问题。
3. 大笔刷 + 自动 downsample 是高风险组合，应作为回归测试场景。

## 7. Action Items

- [ ] 若后续仍有类似问题，考虑引入纹理版本号或 WeakMap<GPUTexture, ...> 作为 BindGroup 缓存 Key，避免 label 重复导致的误用。
- [ ] 建立 GPU 渲染路径的“render scale 变化回归用例”。

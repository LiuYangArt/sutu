# Notes: GPU-First M2 (Single-Layer Paintable)

## Goals
- GPU tile layer display + 全尺寸 scratch
- 无实时 readback；仅 stroke end dirty readback
- 单层 GPU，多层回退 Canvas2D

## Key Decisions
- scratch 继续使用 GPUStrokeAccumulator 的全尺寸纹理
- layer tiles 采用 `rgba8unorm (linear + dither)`（三图对比无肉眼差异）
- selection mask 以 GPU 纹理形式参与 display/commit
- tile size 暂定 512
- allocation probe 已有最小实现（window.__gpuM0Baseline）

## Open Questions
- tile size 256/512 的真实性能差异（后续对比确认）

# Notes: GPU Dual Brush Implementation

## Sources

### Source 1: src/components/Canvas/useBrushRenderer.ts
- CPU 侧使用 applyScatter 生成主/次 dab 位置。
- Dual Brush 次级 dab 由 secondaryStamper 生成 spacing path，scatter/count 在 StrokeAccumulator.stampSecondaryDab 内完成。

### Source 2: src/utils/strokeBuffer.ts
- Dual Brush 采用 stroke-level 结构：primary/dual mask 累积 + applyDualBrushBlend 只改 alpha。
- blendDual 支持 8 个模式（multiply/darken/overlay/colorDodge/colorBurn/linearBurn/hardMix/linearHeight）。

### Source 3: src/gpu/GPUStrokeAccumulator.ts & shaders
- 现有 computeBrush/computeTextureBrush 负责主笔刷，wet edge 为后处理 compute。
- 预览读取 getPresentableTexture，当前只考虑 wet edge。

## Synthesized Findings

### Consistency Constraints
- GPU 必须复刻“dual mask + stroke-level blend”的结构，否则与 CPU/PS 有偏差。
- Secondary 的 scatter/count/angle jitter 必须与 CPU 一致（CPU 负责生成）。

### Integration Points
- GPUStrokeAccumulator 需要新增 dual mask 纹理与 dual blend compute。
- useBrushRenderer 需在 GPU 路径新增 stampSecondaryDab 调用。
- 错误回退需要从 GPUStrokeAccumulator 通知 useBrushRenderer 切换到 CPU，并触发 UI 提示。

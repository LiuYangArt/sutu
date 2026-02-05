# Task Plan: GPU-First M2 (Single-Layer Paintable)

## Goal
以“GPU tile layer + 全尺寸 scratch + 无实时 readback”为核心路径，完成 M0 基线验证与 M2 单层可绘交付，并保持选区与历史在 stroke end 的小范围 readback。

## Phases
- [x] Phase 1: Plan and setup
- [x] Phase 2: M0 baseline + benchmarks
- [x] Phase 3: Tile layer + GPU display
- [x] Phase 4: GPU commit + selection + dirty readback
- [ ] Phase 5: Review and deliver

## Key Questions
1. 单层 GPU 路径的 fallback/切换条件是否稳定？
2. `rgba8unorm` linear + dither vs `rgba8unorm-srgb` 的最终选择？
3. 256/512 tile size 的实际性能差异？

## Decisions Made
- 单层 GPU 可绘优先，多层可见回退 Canvas2D。
- scratch 全尺寸保留，后续再 tile 化。
- 选区与历史在 stroke end 做小范围 readback。

## Errors Encountered
- None

## Status
**Currently in Phase 5** - 回归检查与交付说明

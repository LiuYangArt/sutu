# Task Plan: GPU Dual Brush (Compute)

## Goal
在 WebGPU compute 管线中实现与 CPU/Photoshop 一致的 Dual Brush 效果，并在失败时回退 CPU + 右上角提示。

## Phases
- [x] Phase 1: Plan and setup
- [x] Phase 2: Research/gather information
- [x] Phase 3: Execute/build
- [ ] Phase 4: Review and deliver

## Key Questions
1. Dual Brush GPU 采用哪种结构以对齐 CPU？
2. 失败回退与提示如何落地到现有渲染/状态体系？

## Decisions Made
- Dual Brush 采用“主/次独立 mask + stroke-level blend + wet edge 后处理”的 GPU 管线（与 CPU 一致）。
- 散布/Count 仍由 CPU 生成，GPU 只负责累积与混合。
- compute 失败时：中断当前笔划、回退 CPU，并弹出右上角提示。

## Errors Encountered
- None

## Status
**Currently in Phase 4** - 等待验证与交付

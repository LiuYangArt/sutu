# GPU Dual Brush Design (Compute) - 2026-02-01

## Goal
Implement dual brush on WebGPU compute with CPU/Photoshop parity, including fallback to CPU when compute is unavailable.

## Pipeline
1. Primary stroke accumulation (existing compute pipelines).
2. Secondary mask accumulation into a dual mask buffer (alpha darken).
3. Stroke-level blend: primary alpha + dual mask (8 modes) -> dual blend texture.
4. Wet edge post-process after dual blend (if enabled).
5. Preview/readback uses the presentable texture (dual blend or wet edge display).

## Data/Resources
- `dualMaskBuffer`: `PingPongBuffer` (rgba32float, mask stored in `.r`).
- `dualBlendTexture`: rgba32float output for blended alpha.
- Pipelines: `ComputeDualMaskPipeline`, `ComputeDualTextureMaskPipeline`, `ComputeDualBlendPipeline`.

## Scatter & Randomness
- Secondary dabs generated on CPU (`BrushStamper` + `applyScatter`), matching CPU logic.
- Per-dab random rotation (0-360 degrees) for secondary tips.

## Fallback
- If compute path is unavailable while dual brush is active, request CPU fallback.
- Abort current stroke and show a toast notification.

## Notes
- Dual blend modifies alpha only; RGB stays intact.
- Wet edge must run after dual blend to match CPU ordering.

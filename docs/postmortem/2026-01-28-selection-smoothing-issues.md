# Selection Smoothing Implementation Postmortem

Date: 2026-01-28
Status: In Progress

## 1. Context

To match professional painting software (e.g., Photoshop), we aimed to optimize the smoothness of selection fills. The original implementation produced jagged, pixelated edges for freehand lasso selections.

## 2. Changes Implemented

### Phase 1: Freehand Smoothing

- **Algorithm**: Replaced raw line connections with **Chaikin Subdivision** (Quadratic Bezier with weighted control points).
- **Noise Reduction**: Applied **Ramer-Douglas-Peucker (RDP)** simplification (tolerance: 1.5px) to remove input jitter.
- **Constraint**: Switched from Catmull-Rom (which overshot selection bounds) to Chaikin to guarantee the curve stays within the polygon's convex hull.

### Phase 2: Brush Anti-aliasing

- **Issue**: Brush strokes inside a selection had aliased (jagged) edges even if the selection mask was smooth.
- **Fix**: Updated `GPUStrokeAccumulator` to use the selection mask's alpha channel as a blending factor (`maskAlpha / 255`) instead of a binary check (`maskAlpha === 0`).

### Phase 3: Polygonal vs. Freehand Distinction

- **Logic**: Modified `pathToMask` to accept `lassoMode`.
- **Differentiation**:
  - `freehand` (points > 20): Apply smoothing.
  - `polygonal`: Use standard `lineTo` for sharp corners.

## 3. Current Issues (The "Polygonal Mismatch")

### Observation

Despite the logic to disable smoothing for polygonal selections, user feedback shows that **polygonal selection fills are rounded/shrunk** relative to the visual outline (marching ants).

### Symptoms

- The fill area does not perfectly cover the area defined by the selection points.
- Corners are rounded or the fill is "inset" compared to the dotted line.

### Potential Root Causes to Investigate

1.  **Selection Path Regeneration (`traceMaskToPaths`)**
    - PaintBoard stores the selection primarily as a **Bitmap Mask** (`ImageData`).
    - The "Marching Ants" outline is _regenerated_ from this mask using `traceMaskToPaths` (Moore-Neighbor Tracing).
    - **Hypothesis**: The tracing algorithm might be biased (tracing the center of pixels vs outer edge) or the mask generation itself (via Canvas `fill()`) has anti-aliasing that causes the "thresholded" outline to drift from the fill's visual edge.

2.  **Coordinate Alignment**
    - Canvas `fill()` operates on sub-pixel coordinates.
    - If the input points are integers, `fill()` covers pixels whose centers are inside.
    - `SelectionOverlay` draws the _vector path_ (the input points).
    - If there's a 0.5px offset in rendering logic between the overlay and the mask generation, a mismatch occurs.

3.  **Lasso Mode Persistence**
    - If `lassoMode` is not correctly persisted in the undo/redo stack or during "commit", the re-generated path might be processed incorrectly.
    - However, `pathToMask` generates the mask _once_ at creation. If that initial mask is wrong (smoothed when it shouldn't be), then the fill is wrong.
    - **Counter-evidence**: The user image shows the dotted line is _outside_ the fill. If the mask was smoothed, the dotted line (traced from mask) should _match_ the smooth mask.
    - **CRITICAL**: The fact that the dotted line is **sharp** (polygonal) but the fill is **rounded** suggests they are sourcing from different data, OR the dotted line is the _creation path_ (which hasn't been updated to the committed mask yet?).
    - If the dotted line is the `selectionPath`, and `selectionPath` is traced from the mask, then a smooth mask should yield a smooth outline.
    - **Possibility**: The dotted line shown is the **Creation Preview** (which is sharp vector lines), while the fill is the **Resulting Mask**. If so, `pathToMask` IS applying smoothing when it shouldn't.

## 4. Next Steps

1.  Verify if `lassoMode` is correctly passed to `pathToMask`.
2.  Check why `path.length > 20` heuristic might be failing (complex polygons can exceed 20 points).
3.  Investigate coordinate systems in `pathToMask` vs `SelectionOverlay`.

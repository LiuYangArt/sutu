# Postmortem: Selection Hit Test Mismatch

**Date:** 2026-01-28
**Component:** Canvas / Selection Tool
**Impact:** UX Inconsistency

## Issue Description

Users encountered a bug where the selection could be moved when dragging outside the visible selection area (e.g., the whitespace within the bounding box of a triangular selection). This created a disconnect between the visual cursor state (which correctly showed the "move" icon only when hovering overlapping pixels) and the actual interaction logic.

## Root Cause

Inconsistency in hit-testing logic between the UI layer (Cursor) and the Interaction layer (Handler):

1.  **Visual Layer (`useCursor.ts`)**: Used `isPointInSelection(x, y)` which performs a precision check against the bitmap mask (alpha channel > 0).
2.  **Interaction Layer (`useSelectionHandler.ts`)**: Used `isPointInBounds(x, y)` which only checked if the point was within the rectangular bounding box of the selection.

This discrepancy meant that for non-rectangular selections, the "dead space" inside the bounding box was interactive for moving, despite the cursor indicating otherwise.

## Resolution

Updated `useSelectionHandler.ts` to use `isPointInSelection(x, y)` for the move initiation check.

```typescript
// Before
if (isPointInBounds(canvasX, canvasY)) {
  beginMove(point);
}

// After
if (isPointInSelection(canvasX, canvasY)) {
  beginMove(point);
}
```

## Lessons Learned

- **Single Source of Truth**: Interaction logic and visual feedback logic must strictly share the same validation functions.
- **Precision Matters**: For tools like Magic Wand or Lasso, bounding box approximations are insufficient for interaction testing; pixel-perfect checks are required.

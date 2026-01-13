# Postmortem: Panel Persistence & Anchor Resizing

**Date**: 2026-01-13
**Status**: Resolved
**Related PR**: #32

## Problem Description

### 1. Tools Panel Size Stuck

Users reported that the "Tools" panel was appearing with scrollbars and excess whitespace, even after the code was updated to make it non-resizable and compact. Changing `defaultGeometry` in the code had no effect on reload.

### 2. Anchor Resizing Inversion

When resizing a panel anchored to the **Right** (e.g., Layers Panel) by dragging its **Left** edge:

- **Expected**: The panel expands to the left, keeping the right edge fixed against the window border.
- **Actual**: The panel expanded, but the right edge shifted, detaching from the anchor or pushing off-screen.

## Root Cause Analysis

### 1. Persistence vs. Code Authority

The application uses `zustand/persist` to save panel state (position, size) to `localStorage`.

- When the app loads, `persist` rehydrates the store with the _saved_ state.
- The `registerPanel` function initializes panels but respects existing state.
- **The Bug**: We added `resizable: false` to the config, but we _didn't_ force the dimensions to reset. The store kept the old, large "resizable" dimensions from the user's history, while the code applied the `resizable: false` flag. Result: A locked, incorrectly sized panel.

### 2. Relative Anchor Logic

The resize logic only calculated the new `x, y, width, height` (Geometry).

- **The Bug**: For a right-anchored panel, `offsetX` represents the distance from the _right_ edge.
- When resizing from the left (`delta.x`, `delta.width`), the `x` coordinate changes.
- The system was updating `x` and `width` correctly for the visual DOM, but it failed to recalculate `offsetX`.
- Since `FloatingPanel` uses `offsetX` for positioning when aligned, the stale `offsetX` combined with the new `width` caused the calculated position to slide.

## Solution

### 1. Enforcing Code Constraints

We updated `stores/panel.ts` to strictly enforce geometry resets for locked panels:

```typescript
// If the code says it's NOT resizable, we MUST force the default dimensions.
// This overrides any stale persisted user preference.
if (capabilities.resizable === false) {
  panel.width = config.defaultGeometry.width;
  panel.height = config.defaultGeometry.height;
}
```

### 2. Smart Anchor Updates

We implemented `calculateNewAlignment` in `FloatingPanel/utils.ts`.

- When resizing a right-anchored panel from the left:
  - `New Right Edge = New X + New Width`
  - `New OffsetX = Window Width - New Right Edge`
- This ensures that as the panel grows left, the anchor (distance from right) is explicitly recalculated to remain stable (or update correctly if the edge actually moved).

## Key Takeaways

1. **Migrations are needed for LocalStorage**: When changing default constraints (like `resizable`), assume `localStorage` has the "wrong" old data. Code must explicitly sanitize/reset state on startup.
2. **Anchor Geometry Math**: Standard `x/y` geometry is insufficient for anchored layouts. Always verify how `delta` affects the _anchor reference point_ (e.g., Right/Bottom edge), not just the Top-Left origin.

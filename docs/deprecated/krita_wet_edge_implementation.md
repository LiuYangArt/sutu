# Krita Wet Edge Implementation Analysis

## Overview

Krita is a professional digital painting application. Unlike some other software (e.g., SAI, Clip Studio Paint) which may have a dedicated "Wet Edge" checkbox, Krita achieves this effect primarily through its **Masked Brush** (Dual Brush) engine and **Color Smudge** engine.

## Implementation Mechanisms

### 1. Masked Brush (Dual Brush)

The primary method for simulating "Wet Edge" is the **Masked Brush** feature. This allows a second brush tip to modify the opacity or color of the primary brush tip.

- **Location**: `plugins/paintops/libpaintop/KisMaskingBrushOption.cpp`
- **Mechanism**: A second brush tip is composited with the primary dab using a specific Composite Operation.
- **Relevant Code**:
  - `KisMaskingBrushOption` manages the UI and state for the second brush.
  - `KisMaskingBrushCompositeOpFactory` (`libs/ui/tool/strokes/KisMaskingBrushCompositeOpFactory.cpp`) provides the compositing logic.

#### Supported Composite Operations

The masking brush supports several modes that can be used to create edge effects (e.g., by eroding the center or darkening the edges):

- `COMPOSITE_MULT` (Multiply)
- `COMPOSITE_SUBTRACT`
- `COMPOSITE_BURN`
- `COMPOSITE_DODGE`
- `COMPOSITE_OVERLAY`
- `COMPOSITE_DARKEN`

**Wet Edge Simulation Strategy**:
To simulate a wet edge (darker edge, lighter center):

1.  **Main Tip**: Standard brush shape.
2.  **Mask Tip**: Slightly smaller, soft brush.
3.  **Mode**: `SUBTRACT` (keeps edge opaque, makes center transparent) or `MULTIPLY` (if using a specific gradient).

### 2. Color Smudge Engine (Lightness / Overlay)

The Color Smudge engine (`colorsmudge`) includes strategies that modulate lightness, effectively creating heightmap or impasto effects which feel "wet".

- **Location**: `plugins/paintops/colorsmudge/KisColorSmudgeStrategyLightness.cpp`
- **Method**: `paintDab` calls `modulateLightnessByGrayBrush`.
- **Logic**:
  ```cpp
  // KisColorSmudgeStrategyLightness.cpp
  tempColorDevice->colorSpace()->modulateLightnessByGrayBrush(
      tempColorDevice->data(),
      reinterpret_cast<const QRgb*>(tempHeightmapDevice->data()),
      1.0,
      numPixels);
  ```
  This modulates pixel lightness based on a heightmap (often derived from brush opacity/thickness), which can create darkened edges ("valleys") or lightened centers ("peaks").

### 3. MyPaint Integration

Krita integrates the **MyPaint** brush engine (`plugins/paintops/mypaint`), which has native "Wet" parameters. If a user selects a "Wet" brush in Krita that uses the MyPaint engine, it delegates the logic to `libmypaint`.

## Conclusion for PaintBoard

To implement "Wet Edge" in PaintBoard, adapting the **Masked Brush** approach is recommended for flexibility:

1.  Implement a secondary **Mask Texture/Tip** in the brush engine.
2.  Apply this mask to the primary stroke buffer using a proper composition mode (e.g., source-over with alpha subtraction).
3.  Provide a specific "Wet Edge" preset that pre-configures this mask to be slightly smaller and softer than the main tip.

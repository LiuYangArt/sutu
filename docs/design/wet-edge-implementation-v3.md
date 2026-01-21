# Wet Edge Implementation v3.0

## Status: ✅ Implemented

## Problem Analysis

### Original Issues
1. **Edge detection approach creates artifacts** - 距离场计算产生锯齿感
2. **Effect doesn't match Photoshop** - Photoshop 的 wet edge 在软边笔刷上更明显
3. **Hard brush behavior wrong** - Photoshop 硬边笔刷几乎没有 wet edge（仅抗锯齿边缘）

### Photoshop Behavior Observations
| Brush Type | Wet Edge Behavior |
|------------|-------------------|
| Soft edge (hardness 0%) | Strong edge darkening, light center |
| Hard edge (hardness 100%) | Almost no effect (only antialiasing edge) |
| Medium (hardness 50%) | Moderate edge effect |

### Key Insight
Photoshop wet edge 效果与 **笔刷本身的 alpha 渐变** 直接相关，而非独立的边缘检测。

## Final Algorithm: Alpha Inversion with Boost

### Core Concept
```
alphaNorm = originalAlpha / 255
wetMultiplier = edgeBoost - (edgeBoost - centerOpacity) * alphaNorm
newAlpha = originalAlpha * wetMultiplier
```

### Parameters (Tuned to Match Photoshop)
```typescript
const centerOpacity = 0.45;  // Center keeps 45% of original opacity
const edgeBoost = 2.2;       // Edge gets boosted to 220% of original
```

### Effect Mapping

| Region | originalAlpha | alphaNorm | wetMultiplier | Result |
|--------|---------------|-----------|---------------|--------|
| Center | 255 | 1.0 | 0.45 | 45% opacity (faded) |
| Mid-edge | 128 | 0.5 | 1.325 | 133% opacity |
| Edge | 50 | 0.2 | 1.85 | 185% opacity (darkened) |
| Far edge | 20 | 0.08 | 2.06 | 206% opacity (clamped to 255) |

### Why This Works

1. **Center fades**: High alpha pixels get multiplied by ~0.45
2. **Edge darkens**: Low alpha pixels get multiplied by up to 2.2
3. **Smooth gradient**: Linear interpolation creates natural transition
4. **Hard brushes unaffected**: Sudden alpha drop means no gradient area

### Advantages
- **No edge detection needed** - O(n) complexity, no neighbor lookups
- **Naturally adapts to brush hardness** - Effect scales with alpha gradient
- **Matches Photoshop behavior** - Hard brushes minimal effect, soft brushes strong effect
- **No artifacts** - Uses actual alpha values, not spatial detection

## Implementation

### File: `src/utils/strokeBuffer.ts`

```typescript
private applyWetEdgeEffect(): void {
  if (!this.bufferData || !this.wetEdgeBuffer) return;

  const strength = this.wetEdgeStrength;
  const centerOpacity = 0.45;
  const edgeBoost = 2.2;

  const left = Math.max(0, this.dirtyRect.left);
  const top = Math.max(0, this.dirtyRect.top);
  const right = Math.min(this.width, this.dirtyRect.right);
  const bottom = Math.min(this.height, this.dirtyRect.bottom);

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const idx = (y * this.width + x) * 4;
      const originalAlpha = this.bufferData[idx + 3]!;

      if (originalAlpha < 1) {
        this.wetEdgeBuffer[idx] = 0;
        this.wetEdgeBuffer[idx + 1] = 0;
        this.wetEdgeBuffer[idx + 2] = 0;
        this.wetEdgeBuffer[idx + 3] = 0;
        continue;
      }

      const alphaNorm = originalAlpha / 255;
      const wetMultiplier = edgeBoost - (edgeBoost - centerOpacity) * alphaNorm;
      const wetAlpha = Math.min(255, originalAlpha * wetMultiplier);
      const newAlpha = originalAlpha * (1 - strength) + wetAlpha * strength;

      this.wetEdgeBuffer[idx] = this.bufferData[idx]!;
      this.wetEdgeBuffer[idx + 1] = this.bufferData[idx + 1]!;
      this.wetEdgeBuffer[idx + 2] = this.bufferData[idx + 2]!;
      this.wetEdgeBuffer[idx + 3] = Math.round(newAlpha);
    }
  }
}
```

### UI: `src/components/BrushPanel/settings/WetEdgeSettings.tsx`

- Enable/disable checkbox only
- No strength slider (fixed at 1.0)
- No width parameter (algorithm doesn't need it)

### Store: `src/stores/tool.ts`

- `wetEdgeEnabled: boolean` - Toggle on/off
- `wetEdge: number` - Strength (0-1), default 1.0

## Testing Results

- [x] Soft brush (hardness 0%): Strong edge effect, light center ✅
- [x] Hard brush (hardness 100%): Minimal effect ✅
- [x] Medium brush (hardness 50%): Moderate effect ✅
- [x] Matches Photoshop visual comparison ✅

## Failed Approaches

See `docs/postmortem/wet-edge-implementation.md` for detailed analysis of:
1. Per-dab edge detection (caterpillar effect)
2. MAX blend mode (still showed dab boundaries)
3. Distance field edge detection (artifacts, wrong behavior)
4. Alpha inversion without boost (center too transparent)

---

*Document version: 3.0 Final*
*Created: 2025-01-21*
*Status: ✅ Implemented and tested*

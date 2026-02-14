import { describe, expect, it } from 'vitest';
import { computeAutoDownsampleDecision } from './GPUStrokeAccumulator';

describe('computeAutoDownsampleDecision', () => {
  it('returns true for texture main tip when auto mode and size > 300', () => {
    expect(
      computeAutoDownsampleDecision({
        mode: 'auto',
        brushSize: 350,
        brushHardness: 100,
        hasTextureMainTip: true,
      })
    ).toBe(true);
  });

  it('returns false for procedural tip when hardness >= 70', () => {
    expect(
      computeAutoDownsampleDecision({
        mode: 'auto',
        brushSize: 350,
        brushHardness: 80,
        hasTextureMainTip: false,
      })
    ).toBe(false);
  });

  it('returns true for procedural tip when hardness < 70 and size > 300', () => {
    expect(
      computeAutoDownsampleDecision({
        mode: 'auto',
        brushSize: 350,
        brushHardness: 50,
        hasTextureMainTip: false,
      })
    ).toBe(true);
  });

  it('returns false when size <= 300 regardless of tip type', () => {
    expect(
      computeAutoDownsampleDecision({
        mode: 'auto',
        brushSize: 200,
        brushHardness: 20,
        hasTextureMainTip: true,
      })
    ).toBe(false);
  });

  it('returns false when mode is off', () => {
    expect(
      computeAutoDownsampleDecision({
        mode: 'off',
        brushSize: 600,
        brushHardness: 20,
        hasTextureMainTip: true,
      })
    ).toBe(false);
  });
});

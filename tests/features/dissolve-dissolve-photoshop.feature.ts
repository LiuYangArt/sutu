/**
 * @description Feature test: Dissolve blend mode should match Photoshop-like alpha-noise behavior.
 * @issue #105
 */
import { describe, expect, it } from 'vitest';
import { compositePixelWithTransparentFallback } from '@/utils/layerBlendMath';

describe('[Bug]: Dissolve 这个混合模式效果跟 Photoshop 不一致。', () => {
  it('keeps fully opaque area stable (no dissolve noise in solid core)', () => {
    const outA = compositePixelWithTransparentFallback({
      blendMode: 'dissolve',
      dstRgb: [0, 0, 0],
      dstAlpha: 0,
      srcRgb: [0.75, 0.33, 0.11],
      srcAlpha: 1,
      pixelX: 10,
      pixelY: 10,
    });

    const outB = compositePixelWithTransparentFallback({
      blendMode: 'dissolve',
      dstRgb: [0, 0, 0],
      dstAlpha: 0,
      srcRgb: [0.75, 0.33, 0.11],
      srcAlpha: 1,
      pixelX: 777,
      pixelY: 999,
    });

    expect(outA.alpha).toBe(1);
    expect(outB.alpha).toBe(1);
    expect(outA.rgb[0]).toBeCloseTo(0.75, 8);
    expect(outA.rgb[1]).toBeCloseTo(0.33, 8);
    expect(outA.rgb[2]).toBeCloseTo(0.11, 8);
    expect(outB.rgb[0]).toBeCloseTo(0.75, 8);
    expect(outB.rgb[1]).toBeCloseTo(0.33, 8);
    expect(outB.rgb[2]).toBeCloseTo(0.11, 8);
  });

  it('applies noise only as alpha modulation for semi-transparent edge pixels', () => {
    const out = compositePixelWithTransparentFallback({
      blendMode: 'dissolve',
      dstRgb: [0, 0, 0],
      dstAlpha: 0,
      srcRgb: [0.75, 0.33, 0.11],
      srcAlpha: 0.28,
      pixelX: 321,
      pixelY: 654,
    });

    expect(out.alpha).toBeGreaterThan(0);
    expect(out.alpha).toBeLessThan(1);
    expect(out.rgb[0]).toBeCloseTo(0.75, 8);
    expect(out.rgb[1]).toBeCloseTo(0.33, 8);
    expect(out.rgb[2]).toBeCloseTo(0.11, 8);
  });
});

import { describe, expect, it } from 'vitest';
import type { BlendMode } from '@/stores/document';
import {
  blendRgb,
  compositePixelWithTransparentFallback,
  TRANSPARENT_BACKDROP_EPS,
} from '../layerBlendMath';

const BLEND_MODES: BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
];

describe('layerBlendMath', () => {
  it('blendRgb 支持全部 16 种模式并且结果在合法范围', () => {
    const dst: readonly [number, number, number] = [0.82, 0.17, 0.36];
    const src: readonly [number, number, number] = [0.24, 0.68, 0.91];

    for (const mode of BLEND_MODES) {
      const rgb = blendRgb(mode, dst, src);
      for (const c of rgb) {
        expect(Number.isFinite(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it('当下方 alpha 为 0 时，非 normal 模式应回退为 normal', () => {
    const normal = compositePixelWithTransparentFallback({
      blendMode: 'normal',
      dstRgb: [0.1, 0.2, 0.3],
      dstAlpha: 0,
      srcRgb: [0.8, 0.4, 0.2],
      srcAlpha: 0.75,
    });

    const nonNormalModes: BlendMode[] = ['multiply', 'screen', 'overlay', 'difference'];
    for (const mode of nonNormalModes) {
      const out = compositePixelWithTransparentFallback({
        blendMode: mode,
        dstRgb: [0.1, 0.2, 0.3],
        dstAlpha: 0,
        srcRgb: [0.8, 0.4, 0.2],
        srcAlpha: 0.75,
      });

      expect(out.alpha).toBeCloseTo(normal.alpha, 8);
      expect(out.rgb[0]).toBeCloseTo(normal.rgb[0], 8);
      expect(out.rgb[1]).toBeCloseTo(normal.rgb[1], 8);
      expect(out.rgb[2]).toBeCloseTo(normal.rgb[2], 8);
    }
  });

  it('透明阈值边界：<=eps 回退，>eps 不回退', () => {
    const normalAtEps = compositePixelWithTransparentFallback({
      blendMode: 'normal',
      dstRgb: [0.7, 0.2, 0.4],
      dstAlpha: TRANSPARENT_BACKDROP_EPS,
      srcRgb: [0.2, 0.9, 0.3],
      srcAlpha: 0.9,
    });
    const multiplyAtEps = compositePixelWithTransparentFallback({
      blendMode: 'multiply',
      dstRgb: [0.7, 0.2, 0.4],
      dstAlpha: TRANSPARENT_BACKDROP_EPS,
      srcRgb: [0.2, 0.9, 0.3],
      srcAlpha: 0.9,
    });

    expect(multiplyAtEps.rgb[0]).toBeCloseTo(normalAtEps.rgb[0], 8);
    expect(multiplyAtEps.rgb[1]).toBeCloseTo(normalAtEps.rgb[1], 8);
    expect(multiplyAtEps.rgb[2]).toBeCloseTo(normalAtEps.rgb[2], 8);

    const normalNonTransparent = compositePixelWithTransparentFallback({
      blendMode: 'normal',
      dstRgb: [0.7, 0.2, 0.4],
      dstAlpha: 0.4,
      srcRgb: [0.2, 0.9, 0.3],
      srcAlpha: 0.9,
    });
    const multiplyNonTransparent = compositePixelWithTransparentFallback({
      blendMode: 'multiply',
      dstRgb: [0.7, 0.2, 0.4],
      dstAlpha: 0.4,
      srcRgb: [0.2, 0.9, 0.3],
      srcAlpha: 0.9,
    });

    expect(multiplyNonTransparent.rgb[0]).not.toBeCloseTo(normalNonTransparent.rgb[0], 4);
  });

  it('非透明底色时应继续使用 blend mode（不回退）', () => {
    const out = compositePixelWithTransparentFallback({
      blendMode: 'multiply',
      dstRgb: [1, 0, 0],
      dstAlpha: 1,
      srcRgb: [0, 1, 0],
      srcAlpha: 1,
    });

    expect(out.alpha).toBe(1);
    expect(out.rgb[0]).toBeCloseTo(0, 8);
    expect(out.rgb[1]).toBeCloseTo(0, 8);
    expect(out.rgb[2]).toBeCloseTo(0, 8);
  });
});

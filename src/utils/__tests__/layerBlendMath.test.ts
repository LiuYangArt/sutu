import { describe, expect, it } from 'vitest';
import type { BlendMode } from '@/stores/document';
import {
  blendRgb,
  compositePixelWithTransparentFallback,
  TRANSPARENT_BACKDROP_EPS,
} from '../layerBlendMath';

const BLEND_MODES: BlendMode[] = [
  'normal',
  'dissolve',
  'darken',
  'multiply',
  'color-burn',
  'linear-burn',
  'darker-color',
  'lighten',
  'screen',
  'color-dodge',
  'linear-dodge',
  'lighter-color',
  'overlay',
  'soft-light',
  'hard-light',
  'vivid-light',
  'linear-light',
  'pin-light',
  'hard-mix',
  'difference',
  'exclusion',
  'subtract',
  'divide',
  'hue',
  'saturation',
  'color',
  'luminosity',
];

function hashNoise01ForTest(x: number, y: number): number {
  const xi = x >>> 0;
  const yi = y >>> 0;
  const n = (Math.imul(xi, 1973) + Math.imul(yi, 9277) + 89173) >>> 0;
  const m = ((n << 13) ^ n) >>> 0;
  const mm = Math.imul(m, m);
  const t = (Math.imul(m, (Math.imul(mm, 15731) + 789221) >>> 0) + 1376312589) >>> 0;
  return (t & 0x00ffffff) / 0x00ffffff;
}

function overlayAlpha(base: number, blend: number): number {
  if (base < 0.5) {
    return 2 * base * blend;
  }
  return 1 - 2 * (1 - base) * (1 - blend);
}

function expectRgbCloseTo(
  actual: readonly [number, number, number],
  expected: readonly [number, number, number],
  precision = 8
): void {
  expect(actual[0]).toBeCloseTo(expected[0], precision);
  expect(actual[1]).toBeCloseTo(expected[1], precision);
  expect(actual[2]).toBeCloseTo(expected[2], precision);
}

describe('layerBlendMath', () => {
  it('blendRgb 支持全部 27 种模式并且结果在合法范围', () => {
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

  it('color-burn: 纯黑 source 叠加纯白 backdrop 时应保持白色（PS 对齐）', () => {
    const out = blendRgb('color-burn', [1, 1, 1], [0, 0, 0]);

    expectRgbCloseTo(out, [1, 1, 1]);
  });

  it('color-burn: 纯黑 source 在近白通道上应仅影响非纯白通道（PS 对齐）', () => {
    const out = blendRgb('color-burn', [254 / 255, 1, 1], [0, 0, 0]);

    expectRgbCloseTo(out, [0, 1, 1]);
  });

  it('dissolve 在同一像素坐标下应保持确定性', () => {
    const args = {
      blendMode: 'dissolve' as const,
      dstRgb: [0.1, 0.2, 0.3] as const,
      dstAlpha: 0.35,
      srcRgb: [0.8, 0.4, 0.2] as const,
      srcAlpha: 0.42,
      pixelX: 128,
      pixelY: 64,
    };
    const first = compositePixelWithTransparentFallback(args);
    const second = compositePixelWithTransparentFallback(args);

    expect(first.alpha).toBe(second.alpha);
    expect(first.rgb[0]).toBe(second.rgb[0]);
    expect(first.rgb[1]).toBe(second.rgb[1]);
    expect(first.rgb[2]).toBe(second.rgb[2]);
  });

  it('dissolve 对全不透明像素不应引入噪点', () => {
    const out = compositePixelWithTransparentFallback({
      blendMode: 'dissolve',
      dstRgb: [0.1, 0.2, 0.3],
      dstAlpha: 0,
      srcRgb: [0.8, 0.4, 0.2],
      srcAlpha: 1,
      pixelX: 512,
      pixelY: 256,
    });

    expect(out.alpha).toBe(1);
    expect(out.rgb[0]).toBeCloseTo(0.8, 8);
    expect(out.rgb[1]).toBeCloseTo(0.4, 8);
    expect(out.rgb[2]).toBeCloseTo(0.2, 8);
  });

  it('dissolve 应使用 overlay(noise, alpha) 调制半透明 alpha（非二值）', () => {
    const pixelX = 128;
    const pixelY = 64;
    const srcAlpha = 0.42;
    const expectedAlpha = overlayAlpha(srcAlpha, hashNoise01ForTest(pixelX, pixelY));

    const out = compositePixelWithTransparentFallback({
      blendMode: 'dissolve',
      dstRgb: [0.1, 0.2, 0.3],
      dstAlpha: 0,
      srcRgb: [0.8, 0.4, 0.2],
      srcAlpha,
      pixelX,
      pixelY,
    });

    expect(out.alpha).toBeCloseTo(expectedAlpha, 8);
    expect(out.alpha).toBeGreaterThan(0);
    expect(out.alpha).toBeLessThan(1);
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

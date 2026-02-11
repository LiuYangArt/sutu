import { describe, expect, it } from 'vitest';
import {
  computeGradientT,
  isZeroLengthGradient,
  renderGradientToImageData,
  sampleGradientAt,
} from '../gradientRenderer';
import type { ColorStop, OpacityStop } from '@/stores/gradient';

const COLOR_STOPS: ColorStop[] = [
  { id: 'c0', position: 0, midpoint: 0.5, source: 'fixed', color: '#000000' },
  { id: 'c1', position: 1, midpoint: 0.5, source: 'fixed', color: '#ffffff' },
];

const OPACITY_STOPS: OpacityStop[] = [
  { id: 'o0', position: 0, midpoint: 0.5, opacity: 1 },
  { id: 'o1', position: 1, midpoint: 0.5, opacity: 0 },
];

describe('gradientRenderer', () => {
  it('computes t for all gradient shapes', () => {
    const start = { x: 0, y: 0 };
    const end = { x: 10, y: 0 };

    expect(computeGradientT('linear', { x: 5, y: 0 }, start, end)).toBeCloseTo(0.5, 4);
    expect(computeGradientT('radial', { x: 5, y: 0 }, start, end)).toBeCloseTo(0.5, 4);
    expect(computeGradientT('angle', { x: 10, y: 0 }, start, end)).toBeCloseTo(0, 4);
    expect(computeGradientT('reflected', { x: -5, y: 0 }, start, end)).toBeCloseTo(0.5, 4);
    expect(computeGradientT('diamond', { x: 5, y: 5 }, start, end)).toBeCloseTo(1, 4);
  });

  it('samples color/opacity with reverse and transparency toggle', () => {
    const normal = sampleGradientAt(0.25, COLOR_STOPS, OPACITY_STOPS, {
      foregroundColor: '#112233',
      backgroundColor: '#445566',
    });
    const reverse = sampleGradientAt(
      0.25,
      COLOR_STOPS,
      OPACITY_STOPS,
      { foregroundColor: '#112233', backgroundColor: '#445566' },
      { reverse: true }
    );
    const opaque = sampleGradientAt(
      0.8,
      COLOR_STOPS,
      OPACITY_STOPS,
      { foregroundColor: '#112233', backgroundColor: '#445566' },
      { transparency: false }
    );

    expect(normal.alpha).toBeCloseTo(0.75, 4);
    expect(reverse.rgb[0]).toBeGreaterThan(normal.rgb[0]);
    expect(opaque.alpha).toBe(1);
  });

  it('renders blend with transparent backdrop fallback correctly', () => {
    const dst = new ImageData(new Uint8ClampedArray([0, 0, 0, 0]), 1, 1);
    const outMultiply = renderGradientToImageData({
      width: 1,
      height: 1,
      start: { x: 0, y: 0 },
      end: { x: 1, y: 0 },
      shape: 'linear',
      colorStops: [
        { id: 'c0', position: 0, midpoint: 0.5, source: 'fixed', color: '#ff0000' },
        { id: 'c1', position: 1, midpoint: 0.5, source: 'fixed', color: '#ff0000' },
      ],
      opacityStops: [
        { id: 'o0', position: 0, midpoint: 0.5, opacity: 1 },
        { id: 'o1', position: 1, midpoint: 0.5, opacity: 1 },
      ],
      blendMode: 'multiply',
      opacity: 1,
      reverse: false,
      dither: false,
      transparency: true,
      foregroundColor: '#000000',
      backgroundColor: '#ffffff',
      dstImageData: dst,
    });

    expect(outMultiply.data[0]).toBeGreaterThan(200);
    expect(outMultiply.data[1]).toBe(0);
    expect(outMultiply.data[2]).toBe(0);
    expect(outMultiply.data[3]).toBe(255);
  });

  it('changes output distribution when dither is enabled', () => {
    const dst = new ImageData(new Uint8ClampedArray(8 * 4), 2, 1);
    const base = renderGradientToImageData({
      width: 2,
      height: 1,
      start: { x: 0, y: 0 },
      end: { x: 2, y: 0 },
      shape: 'linear',
      colorStops: COLOR_STOPS,
      opacityStops: OPACITY_STOPS,
      blendMode: 'normal',
      opacity: 1,
      reverse: false,
      dither: false,
      transparency: true,
      foregroundColor: '#000000',
      backgroundColor: '#ffffff',
      dstImageData: dst,
    });

    const dithered = renderGradientToImageData({
      width: 2,
      height: 1,
      start: { x: 0, y: 0 },
      end: { x: 2, y: 0 },
      shape: 'linear',
      colorStops: COLOR_STOPS,
      opacityStops: OPACITY_STOPS,
      blendMode: 'normal',
      opacity: 1,
      reverse: false,
      dither: true,
      transparency: true,
      foregroundColor: '#000000',
      backgroundColor: '#ffffff',
      dstImageData: dst,
    });

    expect(Array.from(dithered.data)).not.toEqual(Array.from(base.data));
  });

  it('detects zero-length drag', () => {
    expect(isZeroLengthGradient({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(true);
    expect(isZeroLengthGradient({ x: 1, y: 1 }, { x: 1.01, y: 1.01 })).toBe(false);
  });

  it('uses midpoint-remapped interpolation', () => {
    const sample = sampleGradientAt(
      0.2,
      [
        { id: 'm0', position: 0, midpoint: 0.5, source: 'fixed', color: '#000000' },
        { id: 'm1', position: 1, midpoint: 0.2, source: 'fixed', color: '#ffffff' },
      ],
      OPACITY_STOPS,
      { foregroundColor: '#000000', backgroundColor: '#ffffff' }
    );

    expect(sample.rgb[0]).toBeCloseTo(0.5, 2);
  });
});

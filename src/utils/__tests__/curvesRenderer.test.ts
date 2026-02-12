import { describe, expect, it } from 'vitest';
import {
  applyCurvesToImageData,
  buildCurveLut,
  computeHistogramsByChannel,
  createIdentityLut,
} from '@/utils/curvesRenderer';

function createImageDataFromRgba(width: number, height: number, rgba: number[]): ImageData {
  return new ImageData(new Uint8ClampedArray(rgba), width, height);
}

function applyCurvesToSinglePixel(
  color: [number, number, number],
  luts: {
    rgb: Uint8Array;
    red: Uint8Array;
    green: Uint8Array;
    blue: Uint8Array;
  }
): [number, number, number] {
  const result = applyCurvesToImageData({
    baseImageData: createImageDataFromRgba(1, 1, [color[0], color[1], color[2], 255]),
    luts,
  });
  return [result.data[0] ?? 0, result.data[1] ?? 0, result.data[2] ?? 0];
}

function createShiftLut(offset: number): Uint8Array {
  const lut = createIdentityLut();
  for (let i = 0; i < lut.length; i += 1) {
    const mapped = Math.max(0, Math.min(255, i + offset));
    lut[i] = mapped;
  }
  return lut;
}

function createInvertLut(): Uint8Array {
  const lut = createIdentityLut();
  for (let i = 0; i < lut.length; i += 1) {
    lut[i] = 255 - i;
  }
  return lut;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace(/^#/, '').trim();
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return [r, g, b];
}

function expectRgbWithinTolerance(
  actual: [number, number, number],
  expected: [number, number, number],
  tolerance: number
): void {
  expect(Math.abs(actual[0] - expected[0])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual[1] - expected[1])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual[2] - expected[2])).toBeLessThanOrEqual(tolerance);
}

describe('curvesRenderer', () => {
  it('legacy kernel keeps monotonic behavior for monotonic control points', () => {
    const lut = buildCurveLut(
      [
        { x: 0, y: 0 },
        { x: 80, y: 160 },
        { x: 180, y: 220 },
        { x: 255, y: 255 },
      ],
      { kernel: 'legacy_monotone' }
    );

    for (let i = 1; i < lut.length; i += 1) {
      const prev = lut[i - 1] ?? 0;
      const current = lut[i] ?? 0;
      expect(current).toBeGreaterThanOrEqual(prev);
    }
  });

  it('natural kernel matches sampled Photoshop RGB outputs', () => {
    const samples = [
      {
        before: '#6646a4',
        point1: { x: 166, y: 224 },
        point2: { x: 108, y: 58 },
        after: '#2c00dc',
      },
      {
        before: '#d4d5c4',
        point1: { x: 204, y: 96 },
        point2: { x: 36, y: 140 },
        after: '#707355',
      },
      {
        before: '#1b1c1a',
        point1: { x: 208, y: 59 },
        point2: { x: 58, y: 212 },
        after: '#797d75',
      },
      {
        before: '#61082c',
        point1: { x: 111, y: 222 },
        point2: { x: 95, y: 89 },
        after: '#690000',
      },
    ];

    for (const sample of samples) {
      const lut = buildCurveLut([sample.point1, sample.point2]);
      const source = hexToRgb(sample.before);
      const expected = hexToRgb(sample.after);
      const mapped: [number, number, number] = [
        lut[source[0]] ?? source[0],
        lut[source[1]] ?? source[1],
        lut[source[2]] ?? source[2],
      ];
      expect(mapped).toEqual(expected);
    }
  });

  it('matches sampled Photoshop stacked RGB + channel outputs', () => {
    const identity = createIdentityLut();
    const cases = [
      {
        before: '#cc7d7d',
        after: '#a6c1c1',
        tolerance: 0,
        luts: {
          rgb: buildCurveLut([{ x: 102, y: 168 }]),
          red: buildCurveLut([{ x: 176, y: 34 }]),
          green: identity,
          blue: identity,
        },
      },
      {
        before: '#33322e',
        after: '#0b440d',
        tolerance: 2,
        luts: {
          rgb: buildCurveLut([{ x: 184, y: 121 }]),
          red: identity,
          green: buildCurveLut([{ x: 57, y: 156 }]),
          blue: identity,
        },
      },
      {
        before: '#ee3d98',
        after: '#fe716f',
        tolerance: 0,
        luts: {
          rgb: buildCurveLut([{ x: 128, y: 206 }]),
          red: identity,
          green: identity,
          blue: buildCurveLut([{ x: 150, y: 57 }]),
        },
      },
    ] as const;

    for (const testCase of cases) {
      const mapped = applyCurvesToSinglePixel(hexToRgb(testCase.before), testCase.luts);
      expectRgbWithinTolerance(mapped, hexToRgb(testCase.after), testCase.tolerance);
    }
  });

  it('identity LUT keeps pixels unchanged', () => {
    const base = createImageDataFromRgba(2, 1, [10, 20, 30, 255, 200, 120, 40, 128]);
    const identity = createIdentityLut();
    const result = applyCurvesToImageData({
      baseImageData: base,
      luts: {
        rgb: identity,
        red: identity,
        green: identity,
        blue: identity,
      },
    });

    expect(Array.from(result.data)).toEqual(Array.from(base.data));
  });

  it('applies per-channel LUT before rgb LUT', () => {
    const base = createImageDataFromRgba(1, 1, [10, 30, 40, 255]);
    const rgb = createShiftLut(10);
    const red = createInvertLut();
    const green = createIdentityLut();
    const blue = createIdentityLut();

    const result = applyCurvesToImageData({
      baseImageData: base,
      luts: { rgb, red, green, blue },
    });

    // red = rgbLut(redLut(10)) = rgbLut(245) = 255
    expect(result.data[0]).toBe(255);
    expect(result.data[1]).toBe(40);
    expect(result.data[2]).toBe(50);
    expect(result.data[3]).toBe(255);
  });

  it('only applies to selected pixels when selection mask exists', () => {
    const base = createImageDataFromRgba(2, 1, [20, 20, 20, 255, 30, 30, 30, 255]);
    const selectionMask = createImageDataFromRgba(2, 1, [0, 0, 0, 255, 0, 0, 0, 0]);
    const rgb = createShiftLut(100);
    const identity = createIdentityLut();

    const result = applyCurvesToImageData({
      baseImageData: base,
      luts: { rgb, red: identity, green: identity, blue: identity },
      selectionMask,
    });

    expect(result.data[0]).toBe(120);
    expect(result.data[1]).toBe(120);
    expect(result.data[2]).toBe(120);

    expect(result.data[4]).toBe(30);
    expect(result.data[5]).toBe(30);
    expect(result.data[6]).toBe(30);
  });

  it('computes independent per-channel histograms for curves panel', () => {
    const image = createImageDataFromRgba(2, 1, [10, 20, 30, 255, 100, 110, 120, 255]);

    const histogramByChannel = computeHistogramsByChannel(image);

    expect(histogramByChannel.red[10]).toBe(1);
    expect(histogramByChannel.red[100]).toBe(1);
    expect(histogramByChannel.green[20]).toBe(1);
    expect(histogramByChannel.green[110]).toBe(1);
    expect(histogramByChannel.blue[30]).toBe(1);
    expect(histogramByChannel.blue[120]).toBe(1);

    const luma0 = Math.round(0.2126 * 10 + 0.7152 * 20 + 0.0722 * 30);
    const luma1 = Math.round(0.2126 * 100 + 0.7152 * 110 + 0.0722 * 120);
    expect(histogramByChannel.rgb[luma0]).toBe(1);
    expect(histogramByChannel.rgb[luma1]).toBe(1);
  });

  it('respects selection mask in all histogram channels', () => {
    const image = createImageDataFromRgba(2, 1, [10, 20, 30, 255, 100, 110, 120, 255]);
    const selectionMask = createImageDataFromRgba(2, 1, [0, 0, 0, 255, 0, 0, 0, 0]);

    const histogramByChannel = computeHistogramsByChannel(image, selectionMask);

    expect(histogramByChannel.red[10]).toBe(1);
    expect(histogramByChannel.red[100] ?? 0).toBe(0);
    expect(histogramByChannel.green[20]).toBe(1);
    expect(histogramByChannel.green[110] ?? 0).toBe(0);
    expect(histogramByChannel.blue[30]).toBe(1);
    expect(histogramByChannel.blue[120] ?? 0).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  computeImageParityMetrics,
  isImageParityPass,
  type ImageParityMetrics,
  type ImageParityThresholds,
} from './imageParity';

function makeImageData(
  width: number,
  height: number,
  rgba: [number, number, number, number]
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return new ImageData(data, width, height);
}

describe('imageParity', () => {
  it('computes zero diff for identical images', () => {
    const a = makeImageData(2, 2, [10, 20, 30, 255]);
    const b = makeImageData(2, 2, [10, 20, 30, 255]);
    const metrics = computeImageParityMetrics(a, b);

    expect(metrics.meanAbsDiff).toBe(0);
    expect(metrics.mismatchRatio).toBe(0);
    expect(metrics.maxDiff).toBe(0);
    expect(metrics.pixelCount).toBe(4);
  });

  it('computes expected diff metrics with mismatch threshold', () => {
    const baseline = makeImageData(1, 2, [0, 0, 0, 255]);
    const candidate = new ImageData(
      new Uint8ClampedArray([
        4,
        0,
        0,
        255, // mismatch (delta > 3)
        2,
        0,
        0,
        255, // within mismatch threshold
      ]),
      1,
      2
    );

    const metrics = computeImageParityMetrics(baseline, candidate, 3);
    expect(metrics.meanAbsDiff).toBeCloseTo(0.75);
    expect(metrics.mismatchRatio).toBeCloseTo(50);
    expect(metrics.maxDiff).toBe(4);
    expect(metrics.pixelCount).toBe(2);
  });

  it('throws when image dimensions do not match', () => {
    const a = makeImageData(1, 1, [0, 0, 0, 255]);
    const b = makeImageData(2, 1, [0, 0, 0, 255]);
    expect(() => computeImageParityMetrics(a, b)).toThrow('Image size mismatch');
  });

  it('evaluates pass/fail using thresholds', () => {
    const thresholds: ImageParityThresholds = {
      meanAbsDiffMax: 3,
      mismatchRatioMax: 1.5,
    };
    const passMetrics: ImageParityMetrics = {
      meanAbsDiff: 2.8,
      mismatchRatio: 1.2,
      maxDiff: 10,
      pixelCount: 1000,
    };
    const failMetrics: ImageParityMetrics = {
      meanAbsDiff: 3.2,
      mismatchRatio: 1.2,
      maxDiff: 12,
      pixelCount: 1000,
    };

    expect(isImageParityPass(passMetrics, thresholds)).toBe(true);
    expect(isImageParityPass(failMetrics, thresholds)).toBe(false);
  });
});

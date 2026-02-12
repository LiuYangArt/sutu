/**
 * @description Feature tests for issue #106 (curves per-channel histogram)
 * @issue #106
 */
import { describe, it, expect } from 'vitest';
import { computeHistogramsByChannel } from '@/utils/curvesRenderer';

function createImageDataFromRgba(width: number, height: number, rgba: number[]): ImageData {
  return new ImageData(new Uint8ClampedArray(rgba), width, height);
}

describe('Issue #106 curves histogram channel switching', () => {
  it('uses dedicated bins for red/green/blue channels', () => {
    const image = createImageDataFromRgba(1, 1, [17, 101, 203, 255]);
    const histogramByChannel = computeHistogramsByChannel(image);

    expect(histogramByChannel.red[17]).toBe(1);
    expect(histogramByChannel.green[101]).toBe(1);
    expect(histogramByChannel.blue[203]).toBe(1);
  });

  it('does not leak hidden pixels when selection mask is applied', () => {
    const image = createImageDataFromRgba(2, 1, [12, 34, 56, 255, 200, 210, 220, 255]);
    const mask = createImageDataFromRgba(2, 1, [0, 0, 0, 255, 0, 0, 0, 0]);
    const histogramByChannel = computeHistogramsByChannel(image, mask);

    expect(histogramByChannel.red[12]).toBe(1);
    expect(histogramByChannel.red[200] ?? 0).toBe(0);
    expect(histogramByChannel.green[34]).toBe(1);
    expect(histogramByChannel.green[210] ?? 0).toBe(0);
    expect(histogramByChannel.blue[56]).toBe(1);
    expect(histogramByChannel.blue[220] ?? 0).toBe(0);
  });
});

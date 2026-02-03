import { describe, it, expect } from 'vitest';
import { generateNoisePattern, NOISE_PATTERN_ID } from './noiseTexture';

function pixelIndex(x: number, y: number, width: number): number {
  return (y * width + x) * 4;
}

describe('noiseTexture', () => {
  it('generates deterministic pattern data', () => {
    const a = generateNoisePattern(32);
    const b = generateNoisePattern(32);

    expect(a.id).toBe(NOISE_PATTERN_ID);
    expect(a.width).toBe(32);
    expect(a.height).toBe(32);
    expect(a.data.length).toBe(32 * 32 * 4);
    expect(a.data).toEqual(b.data);
  });

  it('is tileable (edges match)', () => {
    const p = generateNoisePattern(32);
    const { width, height, data } = p;

    // First/last column match
    for (let y = 0; y < height; y++) {
      const left = pixelIndex(0, y, width);
      const right = pixelIndex(width - 1, y, width);
      expect(data[right]).toBe(data[left]);
      expect(data[right + 1]).toBe(data[left + 1]);
      expect(data[right + 2]).toBe(data[left + 2]);
      expect(data[right + 3]).toBe(data[left + 3]);
    }

    // First/last row match
    for (let x = 0; x < width; x++) {
      const top = pixelIndex(x, 0, width);
      const bottom = pixelIndex(x, height - 1, width);
      expect(data[bottom]).toBe(data[top]);
      expect(data[bottom + 1]).toBe(data[top + 1]);
      expect(data[bottom + 2]).toBe(data[top + 2]);
      expect(data[bottom + 3]).toBe(data[top + 3]);
    }
  });

  it('outputs grayscale RGBA with opaque alpha', () => {
    const p = generateNoisePattern(16);
    const { width, height, data } = p;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = pixelIndex(x, y, width);
        const r = data[idx]!;
        const g = data[idx + 1]!;
        const b = data[idx + 2]!;
        const a = data[idx + 3]!;
        expect(r).toBe(g);
        expect(g).toBe(b);
        expect(a).toBe(255);
      }
    }
  });
});

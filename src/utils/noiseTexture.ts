import type { PatternData } from './patternManager';

export const NOISE_PATTERN_ID = '__noise__';

const DEFAULT_NOISE_SIZE = 256;
const DEFAULT_NOISE_SEED = 0x6e6f6973; // "nois"
const DEFAULT_NOISE_MEAN = 0.5;
const DEFAULT_NOISE_STDDEV = 0.25;

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian01(rand: () => number): number {
  // Box-Muller transform (deterministic via rand())
  let u1 = rand();
  const u2 = rand();
  // Guard against log(0)
  if (u1 < 1e-12) u1 = 1e-12;
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  const v = DEFAULT_NOISE_MEAN + z0 * DEFAULT_NOISE_STDDEV;
  return Math.max(0, Math.min(1, v));
}

function writeGrayPixel(data: Uint8Array, idx: number, v: number): void {
  data[idx] = v;
  data[idx + 1] = v;
  data[idx + 2] = v;
  data[idx + 3] = 255;
}

function copyPixel(data: Uint8Array, srcIdx: number, dstIdx: number): void {
  data[dstIdx] = data[srcIdx]!;
  data[dstIdx + 1] = data[srcIdx + 1]!;
  data[dstIdx + 2] = data[srcIdx + 2]!;
  data[dstIdx + 3] = data[srcIdx + 3]!;
}

/**
 * Generate a deterministic, tileable grayscale noise pattern.
 *
 * Notes:
 * - Tileable: last row/column matches first row/column.
 * - Deterministic: fixed seed.
 * - Distribution: Gaussian around 0.5 (overlay-neutral).
 */
export function generateNoisePattern(size: number = DEFAULT_NOISE_SIZE): PatternData {
  const safeSize = Math.max(2, Math.floor(size));
  const width = safeSize;
  const height = safeSize;
  const data = new Uint8Array(width * height * 4);

  const rand = mulberry32(DEFAULT_NOISE_SEED);

  // Fill inner area (excluding last row/col), then make it seamless by copying edges.
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const t = gaussian01(rand);
      const v = Math.max(0, Math.min(255, Math.floor(t * 256)));
      const idx = (y * width + x) * 4;
      writeGrayPixel(data, idx, v);
    }
  }

  // Copy first column to last column (seamless X tiling)
  for (let y = 0; y < height - 1; y++) {
    const srcIdx = (y * width + 0) * 4;
    const dstIdx = (y * width + (width - 1)) * 4;
    copyPixel(data, srcIdx, dstIdx);
  }

  // Copy first row to last row (seamless Y tiling)
  for (let x = 0; x < width; x++) {
    const srcIdx = (0 * width + x) * 4;
    const dstIdx = ((height - 1) * width + x) * 4;
    copyPixel(data, srcIdx, dstIdx);
  }

  return {
    id: NOISE_PATTERN_ID,
    width,
    height,
    data,
  };
}

let cachedNoisePattern: PatternData | null = null;

export function getNoisePattern(): PatternData {
  if (!cachedNoisePattern) {
    cachedNoisePattern = generateNoisePattern();
  }
  return cachedNoisePattern;
}

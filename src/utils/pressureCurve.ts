import { buildCurveEvaluator } from './curvesRenderer';

export interface PressureCurveControlPoint {
  x: number;
  y: number;
}

export type PressureCurvePreset = 'linear' | 'soft' | 'hard' | 'scurve';

export const PRESSURE_CURVE_LUT_SIZE = 2048;

const MIN_POINTS = 2;
const MIN_X_GAP = 1e-4;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function presetFn(preset: PressureCurvePreset, input: number): number {
  const p = clamp01(input);
  switch (preset) {
    case 'soft':
      return 1 - (1 - p) * (1 - p);
    case 'hard':
      return p * p;
    case 'scurve':
      return p * p * (3 - 2 * p);
    case 'linear':
    default:
      return p;
  }
}

export function getPressureCurvePresetPoints(
  preset: PressureCurvePreset,
  sampleCount: number = 7
): PressureCurveControlPoint[] {
  const safeSamples = Math.max(2, Math.floor(sampleCount));
  const points: PressureCurveControlPoint[] = [];
  for (let i = 0; i < safeSamples; i += 1) {
    const t = i / (safeSamples - 1);
    points.push({ x: t, y: presetFn(preset, t) });
  }
  return points;
}

export function normalizePressureCurvePoints(
  points: readonly PressureCurveControlPoint[]
): PressureCurveControlPoint[] {
  const fallback = getPressureCurvePresetPoints('linear', MIN_POINTS);
  if (!Array.isArray(points) || points.length === 0) return fallback;

  const pointMap = new Map<number, number>();
  for (const point of points) {
    const x = clamp01(point.x);
    const y = clamp01(point.y);
    pointMap.set(x, y);
  }

  if (!pointMap.has(0)) pointMap.set(0, 0);
  if (!pointMap.has(1)) pointMap.set(1, 1);

  const sorted = Array.from(pointMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([x, y]) => ({ x, y }));

  if (sorted.length < MIN_POINTS) return fallback;
  if (sorted.length === MIN_POINTS) return sorted;

  // Keep strict ordering after normalization to avoid drag/serialization precision collisions.
  const normalized: PressureCurveControlPoint[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const point = sorted[i]!;
    if (i === 0) {
      normalized.push({ x: 0, y: clamp01(point.y) });
      continue;
    }
    if (i === sorted.length - 1) {
      normalized.push({ x: 1, y: clamp01(point.y) });
      continue;
    }

    const prev = normalized[i - 1]!;
    const nextRaw = sorted[i + 1]!;
    const minX = Math.min(1, prev.x + MIN_X_GAP);
    const maxX = Math.max(minX, nextRaw.x - MIN_X_GAP);
    normalized.push({
      x: Math.max(minX, Math.min(maxX, point.x)),
      y: clamp01(point.y),
    });
  }
  return normalized;
}

export function buildPressureCurveLut(
  points: readonly PressureCurveControlPoint[],
  lutSize: number = PRESSURE_CURVE_LUT_SIZE
): Float32Array {
  const size = Math.max(2, Math.floor(lutSize));
  const normalized = normalizePressureCurvePoints(points);
  const scaledPoints = normalized.map((point) => ({
    x: point.x * 255,
    y: point.y * 255,
  }));
  const evaluator = buildCurveEvaluator(scaledPoints, { kernel: 'natural' });

  const lut = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    const t = i / (size - 1);
    lut[i] = clamp01(evaluator(t * 255) / 255);
  }
  return lut;
}

export function samplePressureCurveLut(
  lut: Float32Array | null | undefined,
  pressure: number
): number {
  const p = clamp01(pressure);
  if (!lut || lut.length < 2) return p;

  const pos = p * (lut.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lut.length - 1, lo + 1);
  if (lo === hi) {
    return clamp01(lut[lo] ?? p);
  }
  const t = pos - lo;
  const a = lut[lo] ?? p;
  const b = lut[hi] ?? p;
  return clamp01(a + (b - a) * t);
}

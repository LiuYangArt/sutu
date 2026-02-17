import { buildCurveEvaluator } from './curvesRenderer';

export interface PressureCurveControlPoint {
  x: number;
  y: number;
}

export type PressureCurvePreset = 'linear' | 'soft' | 'hard' | 'scurve';

export const PRESSURE_CURVE_LUT_SIZE = 2048;

const MIN_POINTS = 2;
const MIN_X_GAP = 1e-4;
const DEFAULT_COMPRESS_SOURCE_THRESHOLD = 32;
const DEFAULT_COMPRESS_TARGET_MAX_POINTS = 24;
const DEFAULT_COMPRESS_SAMPLE_COUNT = 256;
const DEFAULT_COMPRESS_MAX_ABS_ERROR = 0.015;
const DEFAULT_COMPRESS_MEAN_ABS_ERROR = 0.004;

export interface PressureCurveCompressionOptions {
  sourceThreshold?: number;
  targetMaxPoints?: number;
  sampleCount?: number;
  maxAbsError?: number;
  meanAbsError?: number;
}

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

function pointLineDistance(
  point: PressureCurveControlPoint,
  start: PressureCurveControlPoint,
  end: PressureCurveControlPoint
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq;
  const projX = start.x + t * dx;
  const projY = start.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

function simplifyDouglasPeucker(
  points: readonly PressureCurveControlPoint[],
  epsilon: number
): PressureCurveControlPoint[] {
  if (points.length <= 2) {
    return points.map((point) => ({ x: point.x, y: point.y }));
  }

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const simplifyRange = (startIndex: number, endIndex: number): void => {
    if (endIndex - startIndex <= 1) return;
    const start = points[startIndex]!;
    const end = points[endIndex]!;
    let maxDistance = -1;
    let splitIndex = -1;
    for (let i = startIndex + 1; i < endIndex; i += 1) {
      const current = points[i]!;
      const distance = pointLineDistance(current, start, end);
      if (distance > maxDistance) {
        maxDistance = distance;
        splitIndex = i;
      }
    }
    if (splitIndex >= 0 && maxDistance > epsilon) {
      keep[splitIndex] = true;
      simplifyRange(startIndex, splitIndex);
      simplifyRange(splitIndex, endIndex);
    }
  };

  simplifyRange(0, points.length - 1);

  const simplified: PressureCurveControlPoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    if (!keep[i]) continue;
    const point = points[i]!;
    simplified.push({ x: point.x, y: point.y });
  }
  return simplified;
}

function computeCurveApproximationError(
  baseline: readonly PressureCurveControlPoint[],
  candidate: readonly PressureCurveControlPoint[],
  sampleCount: number
): { maxAbsError: number; meanAbsError: number } {
  const safeSampleCount = Math.max(2, Math.floor(sampleCount));
  const baselineLut = buildPressureCurveLut(baseline, safeSampleCount);
  const candidateLut = buildPressureCurveLut(candidate, safeSampleCount);
  let maxAbsError = 0;
  let sumAbsError = 0;
  for (let i = 0; i < safeSampleCount; i += 1) {
    const delta = Math.abs((baselineLut[i] ?? 0) - (candidateLut[i] ?? 0));
    if (delta > maxAbsError) {
      maxAbsError = delta;
    }
    sumAbsError += delta;
  }
  return {
    maxAbsError,
    meanAbsError: sumAbsError / safeSampleCount,
  };
}

function compressByTargetPointCount(
  points: readonly PressureCurveControlPoint[],
  targetMaxPoints: number
): PressureCurveControlPoint[] {
  if (points.length <= targetMaxPoints) {
    return points.map((point) => ({ x: point.x, y: point.y }));
  }

  let low = 0;
  let high = 1;
  let best = simplifyDouglasPeucker(points, high);

  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2;
    const simplified = simplifyDouglasPeucker(points, mid);
    if (simplified.length > targetMaxPoints) {
      low = mid;
    } else {
      best = simplified;
      high = mid;
    }
  }

  if (best.length > targetMaxPoints) {
    best = simplifyDouglasPeucker(points, 1);
  }

  return best;
}

export function getPressureCurvePresetPoints(
  preset: PressureCurvePreset,
  sampleCount?: number
): PressureCurveControlPoint[] {
  if (typeof sampleCount === 'number' && Number.isFinite(sampleCount) && sampleCount > 2) {
    const safeSamples = Math.max(2, Math.floor(sampleCount));
    const points: PressureCurveControlPoint[] = [];
    for (let i = 0; i < safeSamples; i += 1) {
      const t = i / (safeSamples - 1);
      points.push({ x: t, y: presetFn(preset, t) });
    }
    return points;
  }

  switch (preset) {
    case 'soft':
      return [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.72 },
        { x: 1, y: 1 },
      ];
    case 'hard':
      return [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.28 },
        { x: 1, y: 1 },
      ];
    case 'scurve':
      return [
        { x: 0, y: 0 },
        { x: 0.25, y: 0.16 },
        { x: 0.75, y: 0.84 },
        { x: 1, y: 1 },
      ];
    case 'linear':
    default:
      return [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ];
  }
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

  const sorted = Array.from(pointMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([x, y]) => ({ x, y }));

  if (sorted.length < MIN_POINTS) return fallback;

  const normalized: PressureCurveControlPoint[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const point = sorted[i]!;
    const prev = normalized[i - 1];
    const minX = i === 0 ? 0 : Math.min(1, (prev?.x ?? 0) + MIN_X_GAP);
    const remaining = sorted.length - i - 1;
    const maxX = Math.max(minX, Math.min(1, 1 - remaining * MIN_X_GAP));
    normalized.push({
      x: clamp01(Math.max(minX, Math.min(maxX, point.x))),
      y: clamp01(point.y),
    });
  }
  return normalized;
}

export function compressPressureCurvePoints(
  points: readonly PressureCurveControlPoint[],
  options: PressureCurveCompressionOptions = {}
): PressureCurveControlPoint[] {
  const normalized = normalizePressureCurvePoints(points);
  const sourceThreshold = Math.max(
    2,
    Math.floor(options.sourceThreshold ?? DEFAULT_COMPRESS_SOURCE_THRESHOLD)
  );
  if (normalized.length <= sourceThreshold) {
    return normalized;
  }

  const targetMaxPoints = Math.max(
    2,
    Math.floor(options.targetMaxPoints ?? DEFAULT_COMPRESS_TARGET_MAX_POINTS)
  );
  if (normalized.length <= targetMaxPoints) {
    return normalized;
  }

  const candidate = normalizePressureCurvePoints(
    compressByTargetPointCount(normalized, targetMaxPoints)
  );
  if (candidate.length >= normalized.length) {
    return normalized;
  }

  const sampleCount = Math.max(2, Math.floor(options.sampleCount ?? DEFAULT_COMPRESS_SAMPLE_COUNT));
  const maxAbsThreshold = Math.max(0, options.maxAbsError ?? DEFAULT_COMPRESS_MAX_ABS_ERROR);
  const meanAbsThreshold = Math.max(0, options.meanAbsError ?? DEFAULT_COMPRESS_MEAN_ABS_ERROR);
  const error = computeCurveApproximationError(normalized, candidate, sampleCount);
  if (error.maxAbsError <= maxAbsThreshold && error.meanAbsError <= meanAbsThreshold) {
    return candidate;
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
  const evaluator = buildCurveEvaluator(scaledPoints, {
    kernel: 'natural',
    endpointMode: 'control_points',
  });

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

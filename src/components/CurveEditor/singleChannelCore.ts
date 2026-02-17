import { buildCurveEvaluator, type CurveEndpointMode } from '@/utils/curvesRenderer';

export interface SingleChannelCurvePoint {
  id: string;
  x: number;
  y: number;
}

export interface SingleChannelDragRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface GraphPoint {
  x: number;
  y: number;
}

export const CHANNEL_MIN = 0;
export const CHANNEL_MAX = 255;
export const DEFAULT_GRAPH_SIZE = 256;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function toGraphX(input: number, graphSize = DEFAULT_GRAPH_SIZE): number {
  return (clamp(input, CHANNEL_MIN, CHANNEL_MAX) / CHANNEL_MAX) * graphSize;
}

export function toGraphY(output: number, graphSize = DEFAULT_GRAPH_SIZE): number {
  return graphSize - (clamp(output, CHANNEL_MIN, CHANNEL_MAX) / CHANNEL_MAX) * graphSize;
}

export function fromGraphPoint(clientX: number, clientY: number, rect: DOMRect): GraphPoint {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const safeClientX = Number.isFinite(clientX) ? clientX : rect.left;
  const safeClientY = Number.isFinite(clientY) ? clientY : rect.top;
  const localX = clamp(safeClientX - rect.left, 0, width);
  const localY = clamp(safeClientY - rect.top, 0, height);
  const x = Math.round((localX / width) * CHANNEL_MAX);
  const y = Math.round(CHANNEL_MAX - (localY / height) * CHANNEL_MAX);
  return {
    x: clamp(x, CHANNEL_MIN, CHANNEL_MAX),
    y: clamp(y, CHANNEL_MIN, CHANNEL_MAX),
  };
}

export function fromGraphPointRaw(clientX: number, clientY: number, rect: DOMRect): GraphPoint {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const safeClientX = Number.isFinite(clientX) ? clientX : rect.left;
  const safeClientY = Number.isFinite(clientY) ? clientY : rect.top;
  return {
    x: ((safeClientX - rect.left) / width) * CHANNEL_MAX,
    y: CHANNEL_MAX - ((safeClientY - rect.top) / height) * CHANNEL_MAX,
  };
}

export function canDeletePointAtIndex(index: number, length: number): boolean {
  return index > 0 && index < length - 1;
}

export function getPointDragRange(
  points: readonly Pick<SingleChannelCurvePoint, 'x' | 'y'>[],
  index: number
): SingleChannelDragRange {
  const isFirst = index === 0;
  const isLast = index === points.length - 1;

  if (isFirst) {
    const next = points[index + 1];
    return {
      minX: CHANNEL_MIN,
      maxX: clamp((next?.x ?? CHANNEL_MAX) - 1, CHANNEL_MIN, CHANNEL_MAX),
      minY: CHANNEL_MIN,
      maxY: CHANNEL_MAX,
    };
  }
  if (isLast) {
    const prev = points[index - 1];
    return {
      minX: clamp((prev?.x ?? CHANNEL_MIN) + 1, CHANNEL_MIN, CHANNEL_MAX),
      maxX: CHANNEL_MAX,
      minY: CHANNEL_MIN,
      maxY: CHANNEL_MAX,
    };
  }

  const prev = points[index - 1];
  const next = points[index + 1];
  return {
    minX: (prev?.x ?? CHANNEL_MIN) + 1,
    maxX: (next?.x ?? CHANNEL_MAX) - 1,
    minY: CHANNEL_MIN,
    maxY: CHANNEL_MAX,
  };
}

export function computeOvershootPixels(
  rawValue: number,
  min: number,
  max: number,
  pixelsPerUnit: number
): number {
  const safeScale = Math.max(1e-6, pixelsPerUnit);
  if (rawValue < min) return (min - rawValue) * safeScale;
  if (rawValue > max) return (rawValue - max) * safeScale;
  return 0;
}

export function findHitPointId(
  points: readonly SingleChannelCurvePoint[],
  clientX: number,
  clientY: number,
  rect: DOMRect,
  pointHitRadiusPx: number
): string | null {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const localX = clamp(clientX - rect.left, 0, width);
  const localY = clamp(clientY - rect.top, 0, height);

  for (const point of points) {
    const pointX = (clamp(point.x, CHANNEL_MIN, CHANNEL_MAX) / CHANNEL_MAX) * width;
    const pointY = height - (clamp(point.y, CHANNEL_MIN, CHANNEL_MAX) / CHANNEL_MAX) * height;
    const dx = pointX - localX;
    const dy = pointY - localY;
    if (Math.hypot(dx, dy) <= pointHitRadiusPx) {
      return point.id;
    }
  }
  return null;
}

export function buildSingleChannelCurvePath(
  points: readonly Pick<SingleChannelCurvePoint, 'x' | 'y'>[],
  options: { sampleCount?: number; graphSize?: number; endpointMode?: CurveEndpointMode } = {}
): string {
  const sampleCount = Math.max(2, Math.floor(options.sampleCount ?? 128));
  const graphSize = options.graphSize ?? DEFAULT_GRAPH_SIZE;
  const endpointMode = options.endpointMode ?? 'control_points';
  const evaluator = buildCurveEvaluator(
    points.map((point) => ({ x: point.x, y: point.y })),
    { kernel: 'natural', endpointMode }
  );

  let path = '';
  for (let i = 0; i < sampleCount; i += 1) {
    const input = (i / (sampleCount - 1)) * CHANNEL_MAX;
    const output = evaluator(input);
    const x = toGraphX(input, graphSize);
    const y = toGraphY(output, graphSize);
    path += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
  }
  return path;
}

import type {
  CurveKernel,
  CurvePoint,
  CurvesHistogramByChannel,
  CurvesLuts,
  CurvesPointsByChannel,
  CurvesPreviewPayload,
} from '@/types/curves';

const CHANNEL_MIN = 0;
const CHANNEL_MAX = 255;
const LUT_SIZE = 256;
const DELTA_EPSILON = 1e-6;

type CurveNode = Pick<CurvePoint, 'x' | 'y'>;

interface BuildCurveOptions {
  kernel?: CurveKernel;
}

interface NaturalSpline {
  nodes: CurveNode[];
  secondDerivatives: number[];
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clampByte(value: number): number {
  return clamp(value, CHANNEL_MIN, CHANNEL_MAX);
}

function readLut(lut: Uint8Array, index: number): number {
  return lut[index] ?? index;
}

function mapChannelsThenRgb(
  luts: CurvesLuts,
  r: number,
  g: number,
  b: number
): [number, number, number] {
  const channelR = readLut(luts.red, r);
  const channelG = readLut(luts.green, g);
  const channelB = readLut(luts.blue, b);

  return [readLut(luts.rgb, channelR), readLut(luts.rgb, channelG), readLut(luts.rgb, channelB)];
}

function sampleLutLinear(lut: Uint8Array, input: number): number {
  const clampedInput = clamp(input, CHANNEL_MIN, CHANNEL_MAX);
  const low = Math.floor(clampedInput);
  const high = Math.min(CHANNEL_MAX, low + 1);
  if (high === low) {
    return lut[low] ?? low;
  }
  const t = clampedInput - low;
  const lowValue = lut[low] ?? low;
  const highValue = lut[high] ?? high;
  return lowValue + (highValue - lowValue) * t;
}

export function createIdentityLut(): Uint8Array {
  const lut = new Uint8Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i += 1) {
    lut[i] = i;
  }
  return lut;
}

export function normalizeCurvePoints(points: readonly CurveNode[]): CurveNode[] {
  const pointMap = new Map<number, number>();

  for (const point of points) {
    const x = Math.round(clamp(point.x, CHANNEL_MIN, CHANNEL_MAX));
    const y = Math.round(clamp(point.y, CHANNEL_MIN, CHANNEL_MAX));
    pointMap.set(x, y);
  }

  if (!pointMap.has(CHANNEL_MIN)) {
    pointMap.set(CHANNEL_MIN, CHANNEL_MIN);
  }
  if (!pointMap.has(CHANNEL_MAX)) {
    pointMap.set(CHANNEL_MAX, CHANNEL_MAX);
  }

  const normalized = Array.from(pointMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([x, y]) => ({ x, y }));

  if (normalized.length === 1) {
    const only = normalized[0];
    if (!only)
      return [
        { x: CHANNEL_MIN, y: CHANNEL_MIN },
        { x: CHANNEL_MAX, y: CHANNEL_MAX },
      ];
    if (only.x <= CHANNEL_MIN) {
      return [only, { x: CHANNEL_MAX, y: CHANNEL_MAX }];
    }
    return [{ x: CHANNEL_MIN, y: CHANNEL_MIN }, only];
  }

  return normalized;
}

function buildLegacyMonotoneLut(nodes: readonly CurveNode[]): Uint8Array {
  if (nodes.length < 2) return createIdentityLut();
  const lastIndex = nodes.length - 1;
  const h: number[] = new Array(lastIndex).fill(0);
  const delta: number[] = new Array(lastIndex).fill(0);

  for (let i = 0; i < lastIndex; i += 1) {
    const current = nodes[i];
    const next = nodes[i + 1];
    if (!current || !next) continue;
    const segmentWidth = Math.max(1, next.x - current.x);
    h[i] = segmentWidth;
    delta[i] = (next.y - current.y) / segmentWidth;
  }

  const m: number[] = new Array(nodes.length).fill(0);
  m[0] = delta[0] ?? 0;
  m[lastIndex] = delta[lastIndex - 1] ?? 0;

  for (let i = 1; i < lastIndex; i += 1) {
    const prev = delta[i - 1] ?? 0;
    const next = delta[i] ?? 0;
    m[i] = (prev + next) * 0.5;
  }

  for (let i = 0; i < lastIndex; i += 1) {
    const d = delta[i] ?? 0;
    if (Math.abs(d) <= DELTA_EPSILON) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] ?? 0) / d;
    const b = (m[i + 1] ?? 0) / d;
    const sum = a * a + b * b;
    if (sum > 9) {
      const t = 3 / Math.sqrt(sum);
      m[i] = t * a * d;
      m[i + 1] = t * b * d;
    }
  }

  const lut = createIdentityLut();
  const first = nodes[0];
  const last = nodes[lastIndex];
  if (!first || !last) return lut;

  for (let x = CHANNEL_MIN; x < first.x; x += 1) {
    lut[x] = clampByte(Math.round(first.y));
  }

  for (let i = 0; i < lastIndex; i += 1) {
    const current = nodes[i];
    const next = nodes[i + 1];
    if (!current || !next) continue;
    const width = Math.max(1, next.x - current.x);
    const tangentStart = m[i] ?? 0;
    const tangentEnd = m[i + 1] ?? 0;

    for (let x = current.x; x <= next.x; x += 1) {
      const t = width === 0 ? 0 : (x - current.x) / width;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const y =
        h00 * current.y + h10 * width * tangentStart + h01 * next.y + h11 * width * tangentEnd;
      lut[x] = clampByte(Math.round(y));
    }
  }

  for (let x = last.x + 1; x <= CHANNEL_MAX; x += 1) {
    lut[x] = clampByte(Math.round(last.y));
  }

  return lut;
}

export function buildNaturalSpline(nodes: readonly CurveNode[]): NaturalSpline | null {
  if (nodes.length < 2) return null;

  const secondDerivatives = new Array<number>(nodes.length).fill(0);
  const work = new Array<number>(nodes.length).fill(0);

  secondDerivatives[0] = 0;
  work[0] = 0;

  for (let i = 1; i < nodes.length - 1; i += 1) {
    const prev = nodes[i - 1];
    const current = nodes[i];
    const next = nodes[i + 1];
    if (!prev || !current || !next) continue;

    const denominator = next.x - prev.x;
    if (denominator <= 0) continue;

    const sig = (current.x - prev.x) / denominator;
    const p = sig * (secondDerivatives[i - 1] ?? 0) + 2;
    if (Math.abs(p) <= 1e-12) continue;

    secondDerivatives[i] = (sig - 1) / p;

    const slopeNext = (next.y - current.y) / Math.max(1, next.x - current.x);
    const slopePrev = (current.y - prev.y) / Math.max(1, current.x - prev.x);
    const rhs = (6 * (slopeNext - slopePrev)) / denominator;
    work[i] = (rhs - sig * (work[i - 1] ?? 0)) / p;
  }

  secondDerivatives[nodes.length - 1] = 0;

  for (let k = nodes.length - 2; k >= 0; k -= 1) {
    const current = secondDerivatives[k] ?? 0;
    const nextSecond = secondDerivatives[k + 1] ?? 0;
    const nextWork = work[k] ?? 0;
    secondDerivatives[k] = current * nextSecond + nextWork;
  }

  return {
    nodes: nodes.map((node) => ({ ...node })),
    secondDerivatives,
  };
}

export function evaluateNaturalSplineAt(spline: NaturalSpline, input: number): number {
  const { nodes, secondDerivatives } = spline;
  if (nodes.length === 0) return clamp(input, CHANNEL_MIN, CHANNEL_MAX);

  const x = clamp(input, CHANNEL_MIN, CHANNEL_MAX);
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!first || !last) return x;

  if (x <= first.x) return first.y;
  if (x >= last.x) return last.y;

  let low = 0;
  let high = nodes.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    const midNode = nodes[mid];
    if (!midNode || midNode.x > x) {
      high = mid;
    } else {
      low = mid;
    }
  }

  const left = nodes[low];
  const right = nodes[high];
  if (!left || !right) return x;

  const segmentWidth = right.x - left.x;
  if (segmentWidth <= 0) return left.y;

  const a = (right.x - x) / segmentWidth;
  const b = (x - left.x) / segmentWidth;
  const leftSecond = secondDerivatives[low] ?? 0;
  const rightSecond = secondDerivatives[high] ?? 0;

  return (
    a * left.y +
    b * right.y +
    (((a * a * a - a) * leftSecond + (b * b * b - b) * rightSecond) * segmentWidth * segmentWidth) /
      6
  );
}

function resolveKernel(options?: BuildCurveOptions): CurveKernel {
  return options?.kernel ?? 'natural';
}

function buildEvaluatorFromNodes(
  nodes: readonly CurveNode[],
  kernel: CurveKernel
): (input: number) => number {
  if (kernel === 'legacy_monotone') {
    const lut = buildLegacyMonotoneLut(nodes);
    return (input: number) => sampleLutLinear(lut, input);
  }

  const spline = buildNaturalSpline(nodes);
  if (!spline) {
    return (input: number) => clamp(input, CHANNEL_MIN, CHANNEL_MAX);
  }
  return (input: number) => evaluateNaturalSplineAt(spline, input);
}

export function buildCurveEvaluator(
  points: readonly CurveNode[],
  options?: BuildCurveOptions
): (input: number) => number {
  const nodes = normalizeCurvePoints(points);
  if (nodes.length < 2) {
    return (input: number) => clamp(input, CHANNEL_MIN, CHANNEL_MAX);
  }
  return buildEvaluatorFromNodes(nodes, resolveKernel(options));
}

export function evaluateCurveAt(
  points: readonly CurveNode[],
  input: number,
  options?: BuildCurveOptions
): number {
  return buildCurveEvaluator(points, options)(input);
}

export function buildCurveLut(
  points: readonly CurveNode[],
  options?: BuildCurveOptions
): Uint8Array {
  const nodes = normalizeCurvePoints(points);
  if (nodes.length < 2) {
    return createIdentityLut();
  }

  const kernel = resolveKernel(options);
  if (kernel === 'legacy_monotone') {
    return buildLegacyMonotoneLut(nodes);
  }

  const evaluator = buildEvaluatorFromNodes(nodes, kernel);
  const lut = createIdentityLut();
  for (let x = CHANNEL_MIN; x <= CHANNEL_MAX; x += 1) {
    lut[x] = clampByte(Math.round(evaluator(x)));
  }
  return lut;
}

export function buildCurvesLuts(pointsByChannel: CurvesPointsByChannel): CurvesLuts {
  return {
    rgb: buildCurveLut(pointsByChannel.rgb),
    red: buildCurveLut(pointsByChannel.red),
    green: buildCurveLut(pointsByChannel.green),
    blue: buildCurveLut(pointsByChannel.blue),
  };
}

export function curvesPayloadToLuts(payload: CurvesPreviewPayload): CurvesLuts {
  const toLut = (values: number[]): Uint8Array => {
    const lut = new Uint8Array(LUT_SIZE);
    for (let i = 0; i < LUT_SIZE; i += 1) {
      lut[i] = clampByte(Math.round(values[i] ?? i));
    }
    return lut;
  };

  return {
    rgb: toLut(payload.rgbLut),
    red: toLut(payload.redLut),
    green: toLut(payload.greenLut),
    blue: toLut(payload.blueLut),
  };
}

export function applyCurvesToImageData(args: {
  baseImageData: ImageData;
  luts: CurvesLuts;
  selectionMask?: ImageData | null;
}): ImageData {
  const { baseImageData, luts, selectionMask = null } = args;
  const out = new ImageData(
    new Uint8ClampedArray(baseImageData.data),
    baseImageData.width,
    baseImageData.height
  );
  const data = out.data;
  const maskData = selectionMask?.data ?? null;

  for (let i = 0; i < data.length; i += 4) {
    const maskWeight = maskData ? (maskData[i + 3] ?? 0) / 255 : 1;
    if (maskWeight <= 0) continue;

    const srcR = data[i] ?? 0;
    const srcG = data[i + 1] ?? 0;
    const srcB = data[i + 2] ?? 0;

    const [mappedR, mappedG, mappedB] = mapChannelsThenRgb(luts, srcR, srcG, srcB);

    if (maskWeight >= 1) {
      data[i] = mappedR;
      data[i + 1] = mappedG;
      data[i + 2] = mappedB;
      continue;
    }

    data[i] = clampByte(Math.round(srcR + (mappedR - srcR) * maskWeight));
    data[i + 1] = clampByte(Math.round(srcG + (mappedG - srcG) * maskWeight));
    data[i + 2] = clampByte(Math.round(srcB + (mappedB - srcB) * maskWeight));
  }

  return out;
}

export function computeLumaHistogram(
  imageData: ImageData,
  selectionMask?: ImageData | null
): number[] {
  return computeHistogramsByChannel(imageData, selectionMask).rgb;
}

export function computeHistogramsByChannel(
  imageData: ImageData,
  selectionMask?: ImageData | null
): CurvesHistogramByChannel {
  const histogramByChannel: CurvesHistogramByChannel = {
    rgb: new Array<number>(LUT_SIZE).fill(0),
    red: new Array<number>(LUT_SIZE).fill(0),
    green: new Array<number>(LUT_SIZE).fill(0),
    blue: new Array<number>(LUT_SIZE).fill(0),
  };
  const src = imageData.data;
  const mask = selectionMask?.data ?? null;

  for (let i = 0; i < src.length; i += 4) {
    const alpha = (src[i + 3] ?? 0) / 255;
    if (alpha <= 0) continue;
    const selectionWeight = mask ? (mask[i + 3] ?? 0) / 255 : 1;
    if (selectionWeight <= 0) continue;

    const weight = alpha * selectionWeight;
    const r = src[i] ?? 0;
    const g = src[i + 1] ?? 0;
    const b = src[i + 2] ?? 0;
    const luma = clampByte(Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b));

    histogramByChannel.rgb[luma] = (histogramByChannel.rgb[luma] ?? 0) + weight;
    histogramByChannel.red[r] = (histogramByChannel.red[r] ?? 0) + weight;
    histogramByChannel.green[g] = (histogramByChannel.green[g] ?? 0) + weight;
    histogramByChannel.blue[b] = (histogramByChannel.blue[b] ?? 0) + weight;
  }

  return histogramByChannel;
}

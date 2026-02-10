import { compositePixelWithTransparentFallback, TRANSPARENT_BACKDROP_EPS } from './layerBlendMath';
import type { BlendMode } from '@/stores/document';
import type { ColorStop, GradientShape, OpacityStop } from '@/stores/gradient';

export interface GradientPoint {
  x: number;
  y: number;
}

export interface GradientRenderConfig {
  shape: GradientShape;
  colorStops: ColorStop[];
  opacityStops: OpacityStop[];
  blendMode: BlendMode;
  opacity: number;
  reverse: boolean;
  dither: boolean;
  transparency: boolean;
  foregroundColor: string;
  backgroundColor: string;
}

export interface GradientRenderInput extends GradientRenderConfig {
  width: number;
  height: number;
  start: GradientPoint;
  end: GradientPoint;
  dstImageData: ImageData;
  selectionMask?: ImageData | null;
}

interface ResolvedColorStop {
  position: number;
  rgb: readonly [number, number, number];
}

interface GradientSample {
  rgb: readonly [number, number, number];
  alpha: number;
}

const EPSILON = 1e-6;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeHex(input: string, fallback: string): string {
  const value = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const r = value[1];
    const g = value[2];
    const b = value[3];
    if (r && g && b) {
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = normalizeHex(hex, '#000000');
  const raw = normalized.slice(1);
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return [r / 255, g / 255, b / 255];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hashNoise01(x: number, y: number): number {
  const xi = x >>> 0;
  const yi = y >>> 0;
  const n = (Math.imul(xi, 1973) + Math.imul(yi, 9277) + 89173) >>> 0;
  const m = ((n << 13) ^ n) >>> 0;
  const mm = Math.imul(m, m);
  const t = (Math.imul(m, (Math.imul(mm, 15731) + 789221) >>> 0) + 1376312589) >>> 0;
  return (t & 0x00ffffff) / 0x00ffffff;
}

function resolveStopColor(
  stop: ColorStop,
  foregroundColor: string,
  backgroundColor: string
): [number, number, number] {
  if (stop.source === 'foreground') {
    return hexToRgb(foregroundColor);
  }
  if (stop.source === 'background') {
    return hexToRgb(backgroundColor);
  }
  return hexToRgb(stop.color);
}

function normalizeColorStops(
  stops: ColorStop[],
  foregroundColor: string,
  backgroundColor: string
): ResolvedColorStop[] {
  const normalized = stops
    .map((stop) => ({
      position: clamp01(stop.position),
      rgb: resolveStopColor(stop, foregroundColor, backgroundColor) as readonly [
        number,
        number,
        number,
      ],
    }))
    .sort((a, b) => a.position - b.position);

  if (normalized.length >= 2) return normalized;
  return [
    { position: 0, rgb: hexToRgb(foregroundColor) },
    { position: 1, rgb: hexToRgb(backgroundColor) },
  ];
}

function normalizeOpacityStops(stops: OpacityStop[]): OpacityStop[] {
  const normalized = stops
    .map((stop) => ({
      position: clamp01(stop.position),
      opacity: clamp01(stop.opacity),
      id: stop.id,
    }))
    .sort((a, b) => a.position - b.position);

  if (normalized.length >= 2) return normalized;
  return [
    { id: 'default_o0', position: 0, opacity: 1 },
    { id: 'default_o1', position: 1, opacity: 1 },
  ];
}

function sampleNumberAt<T extends { position: number }>(
  stops: T[],
  t: number,
  picker: (stop: T) => number
): number {
  if (stops.length === 0) return 0;
  if (t <= stops[0]!.position) return picker(stops[0]!);

  for (let i = 1; i < stops.length; i += 1) {
    const right = stops[i]!;
    if (t > right.position) continue;
    const left = stops[i - 1]!;
    const span = Math.max(EPSILON, right.position - left.position);
    const localT = clamp01((t - left.position) / span);
    return lerp(picker(left), picker(right), localT);
  }

  return picker(stops[stops.length - 1]!);
}

function sampleRgbAt(stops: ResolvedColorStop[], t: number): readonly [number, number, number] {
  return [
    sampleNumberAt(stops, t, (stop) => stop.rgb[0]),
    sampleNumberAt(stops, t, (stop) => stop.rgb[1]),
    sampleNumberAt(stops, t, (stop) => stop.rgb[2]),
  ];
}

function sampleAlphaAt(stops: OpacityStop[], t: number, transparency: boolean): number {
  if (!transparency) return 1;
  return sampleNumberAt(stops, t, (stop) => stop.opacity);
}

export function sampleGradientAt(
  t: number,
  colorStops: ColorStop[],
  opacityStops: OpacityStop[],
  colors: { foregroundColor: string; backgroundColor: string },
  options?: { reverse?: boolean; transparency?: boolean }
): GradientSample {
  const clamped = clamp01(t);
  const effectiveT = options?.reverse ? 1 - clamped : clamped;
  const resolvedColorStops = normalizeColorStops(
    colorStops,
    colors.foregroundColor,
    colors.backgroundColor
  );
  const resolvedOpacityStops = normalizeOpacityStops(opacityStops);
  const [r, g, b] = sampleRgbAt(resolvedColorStops, effectiveT);
  const alpha = sampleAlphaAt(resolvedOpacityStops, effectiveT, options?.transparency !== false);

  return {
    rgb: [r, g, b],
    alpha,
  };
}

export function computeGradientT(
  shape: GradientShape,
  point: GradientPoint,
  start: GradientPoint,
  end: GradientPoint
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const lengthSq = length * length;
  if (lengthSq <= EPSILON || length <= EPSILON) {
    return 0;
  }

  const px = point.x - start.x;
  const py = point.y - start.y;
  const dot = px * dx + py * dy;

  switch (shape) {
    case 'radial': {
      const distance = Math.hypot(px, py);
      return clamp01(distance / length);
    }
    case 'angle': {
      const baseAngle = Math.atan2(dy, dx);
      const angle = Math.atan2(py, px);
      const wrapped = (((angle - baseAngle) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      return clamp01(wrapped / (Math.PI * 2));
    }
    case 'reflected': {
      const projection = dot / lengthSq;
      return clamp01(Math.abs(projection));
    }
    case 'diamond': {
      const ux = dx / length;
      const uy = dy / length;
      const vx = -uy;
      const vy = ux;
      const along = Math.abs(px * ux + py * uy);
      const across = Math.abs(px * vx + py * vy);
      return clamp01((along + across) / length);
    }
    case 'linear':
    default:
      return clamp01(dot / lengthSq);
  }
}

export function renderGradientToImageData(input: GradientRenderInput): ImageData {
  const {
    width,
    height,
    start,
    end,
    shape,
    colorStops,
    opacityStops,
    blendMode,
    opacity,
    reverse,
    dither,
    transparency,
    foregroundColor,
    backgroundColor,
    dstImageData,
    selectionMask,
  } = input;

  if (width <= 0 || height <= 0) {
    return new ImageData(1, 1);
  }

  const dst = dstImageData.data;
  const out = new Uint8ClampedArray(dst);
  const effectiveOpacity = clamp01(opacity);
  const hasMask =
    !!selectionMask && selectionMask.width === width && selectionMask.height === height;
  const maskData = hasMask ? selectionMask!.data : null;

  const normalizedColorStops = normalizeColorStops(colorStops, foregroundColor, backgroundColor);
  const normalizedOpacityStops = normalizeOpacityStops(opacityStops);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const maskAlpha = hasMask ? (maskData?.[index + 3] ?? 0) / 255 : 1;
      if (maskAlpha <= 0) continue;

      const t = computeGradientT(shape, { x: x + 0.5, y: y + 0.5 }, start, end);
      const effectiveT = reverse ? 1 - t : t;

      let [srcR, srcG, srcB] = sampleRgbAt(normalizedColorStops, effectiveT);

      if (dither) {
        const n = ((hashNoise01(x, y) - 0.5) * 2) / 255;
        srcR = clamp01(srcR + n);
        srcG = clamp01(srcG + n);
        srcB = clamp01(srcB + n);
      }

      const stopAlpha = sampleAlphaAt(normalizedOpacityStops, effectiveT, transparency);
      const srcAlpha = clamp01(stopAlpha * effectiveOpacity * maskAlpha);
      if (srcAlpha <= 0) continue;

      const result = compositePixelWithTransparentFallback({
        blendMode,
        dstRgb: [(dst[index] ?? 0) / 255, (dst[index + 1] ?? 0) / 255, (dst[index + 2] ?? 0) / 255],
        dstAlpha: (dst[index + 3] ?? 0) / 255,
        srcRgb: [srcR, srcG, srcB],
        srcAlpha,
        pixelX: x,
        pixelY: y,
        transparentBackdropEps: TRANSPARENT_BACKDROP_EPS,
      });

      out[index] = Math.round(clamp01(result.rgb[0]) * 255);
      out[index + 1] = Math.round(clamp01(result.rgb[1]) * 255);
      out[index + 2] = Math.round(clamp01(result.rgb[2]) * 255);
      out[index + 3] = Math.round(clamp01(result.alpha) * 255);
    }
  }

  return new ImageData(out, width, height);
}

export function isZeroLengthGradient(start: GradientPoint, end: GradientPoint): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) <= EPSILON;
}

import type { ColorStop, OpacityStop } from '@/stores/gradient';

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function resolveStopDisplayColor(
  stop: Pick<ColorStop, 'source' | 'color'>,
  foregroundColor: string,
  backgroundColor: string
): string {
  if (stop.source === 'foreground') return foregroundColor;
  if (stop.source === 'background') return backgroundColor;
  return stop.color;
}

function toHexColor(input: string): string {
  const raw = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const r = raw[1];
    const g = raw[2];
    const b = raw[3];
    if (r && g && b) {
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
  }
  return '#000000';
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = toHexColor(hex);
  const raw = normalized.slice(1);
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return [r, g, b];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function sampleNumberAt<T extends { position: number }>(
  stops: T[],
  position: number,
  picker: (stop: T) => number
): number {
  const clamped = clamp01(position);
  if (stops.length === 0) return 0;
  if (clamped <= stops[0]!.position) return picker(stops[0]!);

  for (let i = 1; i < stops.length; i += 1) {
    const right = stops[i]!;
    if (clamped > right.position) continue;
    const left = stops[i - 1]!;
    const span = Math.max(1e-6, right.position - left.position);
    const t = clamp01((clamped - left.position) / span);
    return lerp(picker(left), picker(right), t);
  }

  return picker(stops[stops.length - 1]!);
}

function normalizeOpacityStops(stops: OpacityStop[]): OpacityStop[] {
  const normalized = [...stops]
    .map((stop) => ({
      ...stop,
      position: clamp01(stop.position),
      opacity: clamp01(stop.opacity),
    }))
    .sort((a, b) => a.position - b.position);
  if (normalized.length >= 2) return normalized;
  return [
    { id: 'default_o0', position: 0, opacity: 1 },
    { id: 'default_o1', position: 1, opacity: 1 },
  ];
}

export function buildGradientPreviewCss(
  colorStops: ColorStop[],
  opacityStops: OpacityStop[],
  foregroundColor: string,
  backgroundColor: string,
  transparencyEnabled = true
): string {
  const sortedColors = [...colorStops]
    .map((stop) => ({
      position: clamp01(stop.position),
      rgb: hexToRgb(resolveStopDisplayColor(stop, foregroundColor, backgroundColor)),
    }))
    .sort((a, b) => a.position - b.position);
  if (sortedColors.length === 0) {
    return 'linear-gradient(90deg, rgba(0,0,0,1) 0%, rgba(255,255,255,1) 100%)';
  }

  const sortedOpacity = normalizeOpacityStops(opacityStops);
  const samplePositions = Array.from(
    new Set([
      0,
      1,
      ...sortedColors.map((stop) => stop.position),
      ...sortedOpacity.map((stop) => stop.position),
    ])
  ).sort((a, b) => a - b);

  const items = samplePositions.map((position) => {
    const r = sampleNumberAt(sortedColors, position, (stop) => stop.rgb[0]);
    const g = sampleNumberAt(sortedColors, position, (stop) => stop.rgb[1]);
    const b = sampleNumberAt(sortedColors, position, (stop) => stop.rgb[2]);
    const a = transparencyEnabled
      ? sampleNumberAt(sortedOpacity, position, (stop) => stop.opacity)
      : 1;
    const pct = Math.round(clamp01(position) * 1000) / 10;
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a.toFixed(3)}) ${pct}%`;
  });

  return `linear-gradient(90deg, ${items.join(', ')}), repeating-conic-gradient(#d0d0d0 0% 25%, #f2f2f2 0% 50%)`;
}

export function makeOpacityGradientCss(opacity: number): string {
  const alpha = Math.round(clamp01(opacity) * 100);
  return `linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,${alpha / 100}) 100%)`;
}

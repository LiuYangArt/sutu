import type { ColorStop } from '@/stores/gradient';

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

export function buildGradientPreviewCss(
  colorStops: ColorStop[],
  foregroundColor: string,
  backgroundColor: string
): string {
  const sorted = [...colorStops].sort((a, b) => a.position - b.position);
  if (sorted.length === 0) {
    return 'linear-gradient(90deg, #000000 0%, #ffffff 100%)';
  }

  const items = sorted.map((stop) => {
    const color = resolveStopDisplayColor(stop, foregroundColor, backgroundColor);
    const pct = Math.round(clamp01(stop.position) * 1000) / 10;
    return `${color} ${pct}%`;
  });

  return `linear-gradient(90deg, ${items.join(', ')})`;
}

export function makeOpacityGradientCss(opacity: number): string {
  const alpha = Math.round(clamp01(opacity) * 100);
  return `linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,${alpha / 100}) 100%)`;
}

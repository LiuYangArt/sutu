import type { PaintInfo } from './types';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function mixPaintInfo(from: PaintInfo, to: PaintInfo, tRaw: number): PaintInfo {
  const t = clamp01(tRaw);
  return {
    x_px: from.x_px + (to.x_px - from.x_px) * t,
    y_px: from.y_px + (to.y_px - from.y_px) * t,
    pressure_01: from.pressure_01 + (to.pressure_01 - from.pressure_01) * t,
    drawing_speed_01: from.drawing_speed_01 + (to.drawing_speed_01 - from.drawing_speed_01) * t,
    time_us: Math.round(from.time_us + (to.time_us - from.time_us) * t),
  };
}

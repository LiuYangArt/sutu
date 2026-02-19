import type { DabRequest, PaintInfo } from './core/types';

export interface DabEmitterOptionsV3 {
  size_px: number;
  flow_01: number;
  opacity_01: number;
}

export function emitDabsV3(
  paintInfos: readonly PaintInfo[],
  options: DabEmitterOptionsV3
): DabRequest[] {
  return paintInfos.map((info) => ({
    x_px: info.x_px,
    y_px: info.y_px,
    size_px: options.size_px,
    flow_01: options.flow_01,
    opacity_01: options.opacity_01,
    time_us: info.time_us,
  }));
}

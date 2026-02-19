import { clamp01, type PaintInfo } from './types';

export const KRITA_SENSOR_LUT_SIZE = 256;

export type DynamicSensorInput = 'pressure' | 'speed' | 'time';
export type DynamicSensorDomain = 'scaling' | 'additive' | 'absolute_rotation';

export interface DynamicSensorConfig {
  enabled: boolean;
  input: DynamicSensorInput;
  curve_lut?: Float32Array;
  domain?: DynamicSensorDomain;
}

function sampleLut(lut: Float32Array | null | undefined, value01: number): number {
  if (!lut || lut.length < 2) return clamp01(value01);
  const p = clamp01(value01);
  const pos = p * (lut.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lut.length - 1, lo + 1);
  if (lo === hi) return clamp01(lut[lo] ?? p);
  const t = pos - lo;
  const a = lut[lo] ?? p;
  const b = lut[hi] ?? p;
  return clamp01(a + (b - a) * t);
}

function toCurveDomain(value: number, domain: DynamicSensorDomain): number {
  switch (domain) {
    case 'additive':
      return clamp01((value + 1) * 0.5);
    case 'absolute_rotation':
      return clamp01((((value % 360) + 360) % 360) / 360);
    case 'scaling':
    default:
      return clamp01(value);
  }
}

function fromCurveDomain(value: number, domain: DynamicSensorDomain): number {
  switch (domain) {
    case 'additive':
      return value * 2 - 1;
    case 'absolute_rotation':
      return value * 360;
    case 'scaling':
    default:
      return clamp01(value);
  }
}

function readSensorInput(info: PaintInfo, input: DynamicSensorInput): number {
  switch (input) {
    case 'pressure':
      return info.pressure_01;
    case 'speed':
      return info.drawing_speed_01;
    case 'time':
      return clamp01(info.time_us / 1_000_000);
    default:
      return 0;
  }
}

export function createLinearSensorLut(size: number = KRITA_SENSOR_LUT_SIZE): Float32Array {
  const safeSize = Math.max(2, Math.floor(size));
  const lut = new Float32Array(safeSize);
  for (let i = 0; i < safeSize; i += 1) {
    lut[i] = i / (safeSize - 1);
  }
  return lut;
}

export function evaluateDynamicSensor(info: PaintInfo, config: DynamicSensorConfig): number {
  if (!config.enabled) return 1;
  const domain = config.domain ?? 'scaling';
  const rawInput = readSensorInput(info, config.input);
  const domainValue = toCurveDomain(rawInput, domain);
  const mapped = sampleLut(config.curve_lut, domainValue);
  return fromCurveDomain(mapped, domain);
}

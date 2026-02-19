import {
  buildPressureCurveLut,
  getPressureCurvePresetPoints,
  samplePressureCurveLut,
  type PressureCurveControlPoint,
} from '@/utils/pressureCurve';
import { clamp01 } from './types';

export const KRITA_GLOBAL_PRESSURE_LUT_SIZE = 1025;

export function createDefaultGlobalPressureLut(): Float32Array {
  return buildPressureCurveLut(
    getPressureCurvePresetPoints('linear', 2),
    KRITA_GLOBAL_PRESSURE_LUT_SIZE
  );
}

export function createGlobalPressureLutFromPoints(
  points: readonly PressureCurveControlPoint[]
): Float32Array {
  return buildPressureCurveLut(points, KRITA_GLOBAL_PRESSURE_LUT_SIZE);
}

export function sampleGlobalPressureCurve(
  lut: Float32Array | null | undefined,
  pressure: number
): number {
  if (!lut || lut.length < 2) return clamp01(pressure);
  return samplePressureCurveLut(lut, pressure);
}

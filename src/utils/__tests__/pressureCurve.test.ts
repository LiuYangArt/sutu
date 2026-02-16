import { describe, expect, it } from 'vitest';
import {
  PRESSURE_CURVE_LUT_SIZE,
  buildPressureCurveLut,
  getPressureCurvePresetPoints,
  normalizePressureCurvePoints,
  samplePressureCurveLut,
} from '@/utils/pressureCurve';

describe('pressureCurve utils', () => {
  it('builds 2048 LUT by default', () => {
    const lut = buildPressureCurveLut(getPressureCurvePresetPoints('linear'));
    expect(lut.length).toBe(PRESSURE_CURVE_LUT_SIZE);
    expect(lut[0]).toBeCloseTo(0, 6);
    expect(lut[lut.length - 1]).toBeCloseTo(1, 6);
  });

  it('normalizes points and keeps fixed endpoints', () => {
    const points = normalizePressureCurvePoints([
      { x: 0.4, y: 0.2 },
      { x: 0.4, y: 0.7 },
      { x: 0.9, y: 1.2 },
    ]);
    expect(points[0]?.x).toBe(0);
    expect(points[points.length - 1]?.x).toBe(1);
    expect(points[0]?.y).toBeGreaterThanOrEqual(0);
    expect(points[points.length - 1]?.y).toBeLessThanOrEqual(1);
  });

  it('samples LUT with interpolation and clamps out-of-range inputs', () => {
    const lut = buildPressureCurveLut(getPressureCurvePresetPoints('soft'));
    const below = samplePressureCurveLut(lut, -1);
    const mid = samplePressureCurveLut(lut, 0.5);
    const above = samplePressureCurveLut(lut, 2);
    expect(below).toBeCloseTo(0, 6);
    expect(mid).toBeGreaterThan(0.5);
    expect(above).toBeCloseTo(1, 6);
  });
});

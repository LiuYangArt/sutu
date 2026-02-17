import { describe, expect, it } from 'vitest';
import { BrushSpeedEstimator } from '@/utils/brushSpeedEstimator';

describe('BrushSpeedEstimator', () => {
  it('first point speed is always zero', () => {
    const estimator = new BrushSpeedEstimator();
    const speed = estimator.getNextSpeedPxPerMs(10, 20, 100, { smoothingSamples: 3 });
    expect(speed).toBe(0);
    expect(estimator.getLastSpeedPxPerMs()).toBe(0);
  });

  it('smoothing samples dampen sudden speed spikes', () => {
    const reactiveEstimator = new BrushSpeedEstimator();
    const smoothEstimator = new BrushSpeedEstimator();

    const seedPoints = Array.from({ length: 10 }, (_, i) => ({
      x: i,
      y: 0,
      t: i * 10,
    }));

    for (const point of seedPoints) {
      reactiveEstimator.getNextSpeedPxPerMs(point.x, point.y, point.t, { smoothingSamples: 3 });
      smoothEstimator.getNextSpeedPxPerMs(point.x, point.y, point.t, { smoothingSamples: 60 });
    }

    const reactive = reactiveEstimator.getNextSpeedPxPerMs(40, 0, 110, { smoothingSamples: 3 });
    const smooth = smoothEstimator.getNextSpeedPxPerMs(40, 0, 110, { smoothingSamples: 60 });

    expect(reactive).toBeGreaterThan(0);
    expect(smooth).toBeGreaterThan(0);
    expect(smooth).toBeLessThan(reactive);
  });

  it('normalizes speed with configured max speed cap', () => {
    const estimator = new BrushSpeedEstimator();
    estimator.getNextSpeedPxPerMs(0, 0, 0, { smoothingSamples: 3 });
    estimator.getNextSpeedPxPerMs(100, 0, 10, { smoothingSamples: 3 });

    expect(estimator.getNormalizedSpeed(5)).toBe(1);
    expect(estimator.getNormalizedSpeed(20)).toBeCloseTo(0.5, 3);
  });

  it('keeps speed finite when receiving abnormal dt values', () => {
    const estimator = new BrushSpeedEstimator();
    estimator.getNextSpeedPxPerMs(0, 0, 100, { smoothingSamples: 3 });

    const negativeDtSpeed = estimator.getNextSpeedPxPerMs(8, 0, 90, { smoothingSamples: 3 });
    const hugeDtSpeed = estimator.getNextSpeedPxPerMs(16, 0, 5000, { smoothingSamples: 3 });

    expect(Number.isFinite(negativeDtSpeed)).toBe(true);
    expect(Number.isFinite(hugeDtSpeed)).toBe(true);
    expect(negativeDtSpeed).toBeGreaterThanOrEqual(0);
    expect(hugeDtSpeed).toBeGreaterThanOrEqual(0);
  });
});

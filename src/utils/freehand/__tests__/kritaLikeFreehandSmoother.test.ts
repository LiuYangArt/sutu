import { describe, expect, it } from 'vitest';
import { KritaLikeFreehandSmoother } from '../kritaLikeFreehandSmoother';

describe('KritaLikeFreehandSmoother', () => {
  it('does not emit segment for the first point', () => {
    const smoother = new KritaLikeFreehandSmoother();
    const segments = smoother.processPoint({ x: 0, y: 0, pressure: 0.4, timestampMs: 0 });
    expect(segments).toEqual([]);
  });

  it('emits real-segment midpoint chain and flushes final half-segment', () => {
    const smoother = new KritaLikeFreehandSmoother();
    smoother.processPoint({ x: 0, y: 0, pressure: 0.5, timestampMs: 0 });
    const second = smoother.processPoint({ x: 10, y: 0, pressure: 0.5, timestampMs: 10 });
    const third = smoother.processPoint({ x: 20, y: 0, pressure: 0.5, timestampMs: 20 });
    const tail = smoother.finishStrokeSegment();

    expect(second.length).toBe(1);
    expect(second[0]!.from.x).toBeCloseTo(0, 6);
    expect(second[0]!.to.x).toBeCloseTo(10, 6);

    expect(third.length).toBe(1);
    expect(third[0]!.from.x).toBeCloseTo(10, 6);
    expect(third[0]!.to.x).toBeCloseTo(15, 6);

    expect(tail).toBeTruthy();
    expect(tail?.from.x).toBeCloseTo(15, 6);
    expect(tail?.to.x).toBeCloseTo(20, 6);
  });

  it('never extrapolates beyond final real point', () => {
    const smoother = new KritaLikeFreehandSmoother();
    smoother.processPoint({ x: 0, y: 0, pressure: 0.5, timestampMs: 0 });
    smoother.processPoint({ x: 10, y: 0, pressure: 0.5, timestampMs: 8 });
    smoother.processPoint({ x: 12, y: 2, pressure: 0.4, timestampMs: 16 });
    const tail = smoother.finishStrokeSegment();

    expect(tail).toBeTruthy();
    if (!tail) return;
    expect(tail.to.x).toBeLessThanOrEqual(12 + 1e-6);
    expect(tail.to.y).toBeLessThanOrEqual(2 + 1e-6);
  });
});

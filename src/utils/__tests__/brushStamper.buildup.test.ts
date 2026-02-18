import { describe, it, expect } from 'vitest';
import { BrushStamper } from '@/utils/strokeBuffer';

describe('BrushStamper build-up', () => {
  it('strict mode emits first dab immediately and avoids stationary buildup when disabled', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();

    const first = stamper.processPoint(10, 10, 0.5, 10);
    expect(first.length).toBe(1);
    expect(first[0]!.x).toBeCloseTo(10, 6);
    expect(first[0]!.y).toBeCloseTo(10, 6);
    expect(first[0]!.pressure).toBeCloseTo(0.5, 6);

    expect(stamper.processPoint(10, 10, 0.5, 10)).toEqual([]);
    expect(stamper.processPoint(10, 10, 0.5, 10)).toEqual([]);

    // Under spacing threshold, still no extra dabs.
    expect(stamper.processPoint(12, 10, 0.5, 10)).toEqual([]);

    // Move enough to cross spacing threshold and emit regular dabs.
    const dabs = stamper.processPoint(25, 10, 0.5, 10);
    expect(dabs.length).toBeGreaterThanOrEqual(1);
    const last = dabs[dabs.length - 1]!;
    expect(last.x).toBeLessThanOrEqual(25);
    expect(last.y).toBeCloseTo(10, 6);
    expect(last.pressure).toBeCloseTo(0.5, 6);
  });

  it('emits dabs while stationary when buildup enabled', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();

    const first = stamper.processPoint(20, 20, 0.5, 10, true);
    expect(first.length).toBe(1);
    expect(first[0]!.x).toBeCloseTo(20, 6);
    expect(first[0]!.y).toBeCloseTo(20, 6);

    const second = stamper.processPoint(20, 20, 0.5, 10, true);
    expect(second.length).toBe(1);
    expect(second[0]!.x).toBeCloseTo(20, 6);
    expect(second[0]!.y).toBeCloseTo(20, 6);

    const third = stamper.processPoint(20, 20, 0.5, 10, true);
    expect(third.length).toBe(1);
  });
});

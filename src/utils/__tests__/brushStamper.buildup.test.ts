import { describe, it, expect } from 'vitest';
import { BrushStamper } from '@/utils/strokeBuffer';

describe('BrushStamper build-up', () => {
  it('does not emit dabs while stationary when buildup disabled', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();

    expect(stamper.processPoint(10, 10, 0.5, 10)).toEqual([]);
    expect(stamper.processPoint(10, 10, 0.5, 10)).toEqual([]);
    expect(stamper.processPoint(10, 10, 0.5, 10)).toEqual([]);

    // Still under MIN_MOVEMENT_DISTANCE (3px)
    expect(stamper.processPoint(12, 10, 0.5, 10)).toEqual([]);

    // Now move enough -> should start emitting a smooth start transition
    const dabs = stamper.processPoint(13, 10, 0.5, 10);
    expect(dabs.length).toBeGreaterThanOrEqual(2);
    expect(dabs[0]!.x).toBeGreaterThan(10);
    expect(dabs[0]!.x).toBeLessThan(13);
    expect(dabs[0]!.y).toBeCloseTo(10, 6);
    expect(dabs[0]!.pressure).toBeGreaterThan(0);
    expect(dabs[0]!.pressure).toBeLessThan(0.5);
    const last = dabs[dabs.length - 1]!;
    expect(last.x).toBeCloseTo(13, 6);
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

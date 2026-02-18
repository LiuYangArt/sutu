import { describe, expect, it } from 'vitest';
import { BrushStamper } from '@/utils/strokeBuffer';

function meanAdjacentDelta(values: number[]): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < values.length; i += 1) {
    sum += Math.abs(values[i]! - values[i - 1]!);
  }
  return sum / (values.length - 1);
}

describe('BrushStamper speed-based smoothing and finalize sampling', () => {
  it('emits first dab immediately without start-distance gate', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();

    const firstDabs = stamper.processPoint(100, 100, 0.6, 2, false, {
      timestampMs: 0,
      maxBrushSpeedPxPerMs: 30,
      brushSpeedSmoothingSamples: 3,
    });

    expect(firstDabs.length).toBe(1);
    expect(firstDabs[0]?.x).toBe(100);
    expect(firstDabs[0]?.pressure).toBeCloseTo(0.6, 4);
  });

  it('keeps lowPressureAdaptiveSmoothingEnabled as no-op in strict mode', () => {
    const adaptive = new BrushStamper();
    const baseline = new BrushStamper();
    adaptive.beginStroke();
    baseline.beginStroke();

    const pressurePattern = [0.02, 0.11, 0.03, 0.1, 0.04, 0.09, 0.02, 0.1];
    const adaptivePressures: number[] = [];
    const baselinePressures: number[] = [];

    for (let i = 0; i < pressurePattern.length; i += 1) {
      const x = i * 4;
      const pressure = pressurePattern[i]!;
      const timestampMs = i * 4;

      const adaptiveDabs = adaptive.processPoint(x, 0, pressure, 2, false, {
        timestampMs,
        maxBrushSpeedPxPerMs: 1,
        brushSpeedSmoothingSamples: 3,
        lowPressureAdaptiveSmoothingEnabled: true,
      });
      adaptivePressures.push(...adaptiveDabs.map((dab) => dab.pressure));

      const baselineDabs = baseline.processPoint(x, 0, pressure, 2, false, {
        timestampMs,
        maxBrushSpeedPxPerMs: 1,
        brushSpeedSmoothingSamples: 3,
        lowPressureAdaptiveSmoothingEnabled: false,
      });
      baselinePressures.push(...baselineDabs.map((dab) => dab.pressure));
    }

    expect(adaptivePressures.length).toBeGreaterThan(2);
    expect(baselinePressures.length).toBeGreaterThan(2);
    expect(meanAdjacentDelta(adaptivePressures)).toBeCloseTo(
      meanAdjacentDelta(baselinePressures),
      8
    );
  });

  it('finalize dabs stay on the last real segment and keep pressure continuity', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();
    const mainDabs: Array<{ x: number; y: number; pressure: number }> = [];

    for (let i = 0; i < 9; i += 1) {
      const dabs = stamper.processPoint(i * 6, 0, 0.4, 2, false, {
        timestampMs: i * 4,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
      });
      mainDabs.push(...dabs);
    }

    const finalizeDabs = stamper.finishStroke(24, {
      maxBrushSpeedPxPerMs: 30,
      brushSpeedSmoothingSamples: 3,
      maxDabIntervalMs: 1,
    });
    const snapshot = stamper.getStrokeFinalizeDebugSnapshot();
    expect(mainDabs.length).toBeGreaterThan(0);
    expect(finalizeDabs.length).toBeGreaterThan(0);
    expect(snapshot).toBeTruthy();
    expect(snapshot?.reason).toBe('emitted_segment');
    const firstMain = mainDabs[mainDabs.length - 1];
    const first = finalizeDabs[0];
    const last = finalizeDabs[finalizeDabs.length - 1];
    expect(first).toBeTruthy();
    expect(last).toBeTruthy();
    expect(firstMain).toBeTruthy();
    if (!first || !last || !firstMain) return;

    // Main segment and finalize segment should remain continuous in pressure,
    // instead of dropping to synthetic near-zero values.
    expect(Math.abs(first.pressure - firstMain.pressure)).toBeLessThan(0.2);
    expect(last.pressure).toBeGreaterThan(0.15);

    // Finalize dabs must stay inside the final real segment domain and never overshoot.
    for (const dab of finalizeDabs) {
      expect(dab.x).toBeGreaterThanOrEqual(42 - 1e-6);
      expect(dab.x).toBeLessThanOrEqual(48 + 1e-6);
      expect(dab.y).toBeCloseTo(0, 6);
    }
  });

  it('keeps trajectory smoothing isolated by default in this branch', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();

    for (let i = 0; i < 9; i += 1) {
      stamper.processPoint(i * 6, 0, 0.4, 2, false, {
        timestampMs: i * 4,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
      });
    }

    const finalizeDabs = stamper.finishStroke(24, {
      maxBrushSpeedPxPerMs: 30,
      brushSpeedSmoothingSamples: 3,
      maxDabIntervalMs: 1,
    });
    const snapshot = stamper.getStrokeFinalizeDebugSnapshot();

    expect(finalizeDabs.length).toBeGreaterThan(0);
    expect(snapshot?.reason).toBe('emitted_segment');
  });

  it('timing channel emits extra dabs when distance movement is tiny', () => {
    const emitMicroSegmentDabs = (maxDabIntervalMs: number): number => {
      const stamper = new BrushStamper();
      stamper.beginStroke();

      stamper.processPoint(0, 0, 0.45, 6, false, {
        timestampMs: 0,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        maxDabIntervalMs,
      });
      stamper.processPoint(4, 0, 0.45, 6, false, {
        timestampMs: 8,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        maxDabIntervalMs,
      });

      let emitted = 0;
      for (let i = 0; i < 6; i += 1) {
        const dabs = stamper.processPoint(4 + (i + 1) * 0.08, 0, 0.45, 6, false, {
          timestampMs: 48 + i * 40,
          maxBrushSpeedPxPerMs: 30,
          brushSpeedSmoothingSamples: 3,
          maxDabIntervalMs,
        });
        emitted += dabs.length;
      }
      return emitted;
    };

    const timingDriven = emitMicroSegmentDabs(10);
    const distanceOnly = emitMicroSegmentDabs(1000);

    expect(timingDriven).toBeGreaterThan(0);
    expect(timingDriven).toBeGreaterThan(distanceOnly);
  });
});

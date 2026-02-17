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
  it('uses linear pressure interpolation for in-segment dabs', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();

    stamper.processPoint(0, 0, 0, 6, true, {
      timestampMs: 0,
      maxBrushSpeedPxPerMs: 30,
      brushSpeedSmoothingSamples: 3,
      pressureEmaEnabled: false,
      pressureChangeSpacingBoostEnabled: false,
      lowPressureDensityBoostEnabled: false,
      trajectorySmoothingEnabled: false,
      maxDabIntervalMs: 1000,
    });

    const segmentDabs = stamper.processPoint(10, 0, 1, 6, true, {
      timestampMs: 10,
      maxBrushSpeedPxPerMs: 30,
      brushSpeedSmoothingSamples: 3,
      pressureEmaEnabled: false,
      pressureChangeSpacingBoostEnabled: false,
      lowPressureDensityBoostEnabled: false,
      trajectorySmoothingEnabled: false,
      maxDabIntervalMs: 1000,
    });

    expect(segmentDabs.length).toBeGreaterThan(0);
    const first = segmentDabs[0];
    expect(first).toBeTruthy();
    if (!first) return;

    // spacing=6 on a 10px segment => first sample t=0.6, pressure should be linear 0.6
    expect(first.pressure).toBeCloseTo(0.6, 3);
  });

  it('supports independent pressure heuristic toggles', () => {
    const runPressureChangeSpacing = (enabled: boolean): number => {
      const stamper = new BrushStamper();
      stamper.beginStroke();
      stamper.processPoint(0, 0, 0.2, 6, true, {
        timestampMs: 0,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        pressureEmaEnabled: false,
        pressureChangeSpacingBoostEnabled: enabled,
        lowPressureDensityBoostEnabled: false,
        lowPressureAdaptiveSmoothingEnabled: false,
        trajectorySmoothingEnabled: false,
        maxDabIntervalMs: 1000,
      });
      const dabs = stamper.processPoint(12, 0, 0.8, 6, true, {
        timestampMs: 12,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        pressureEmaEnabled: false,
        pressureChangeSpacingBoostEnabled: enabled,
        lowPressureDensityBoostEnabled: false,
        lowPressureAdaptiveSmoothingEnabled: false,
        trajectorySmoothingEnabled: false,
        maxDabIntervalMs: 1000,
      });
      return dabs.length;
    };

    const runLowPressureDensity = (enabled: boolean): number => {
      const stamper = new BrushStamper();
      stamper.beginStroke();
      stamper.processPoint(0, 0, 0.08, 6, true, {
        timestampMs: 0,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        pressureEmaEnabled: false,
        pressureChangeSpacingBoostEnabled: false,
        lowPressureDensityBoostEnabled: enabled,
        lowPressureAdaptiveSmoothingEnabled: false,
        trajectorySmoothingEnabled: false,
        maxDabIntervalMs: 1000,
      });
      const dabs = stamper.processPoint(50, 0, 0.07, 10, true, {
        timestampMs: 50,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        pressureEmaEnabled: false,
        pressureChangeSpacingBoostEnabled: false,
        lowPressureDensityBoostEnabled: enabled,
        lowPressureAdaptiveSmoothingEnabled: false,
        trajectorySmoothingEnabled: false,
        maxDabIntervalMs: 1000,
      });
      return dabs.length;
    };

    const runPressureEma = (enabled: boolean): number => {
      const stamper = new BrushStamper();
      stamper.beginStroke();
      stamper.processPoint(0, 0, 0, 6, true, {
        timestampMs: 0,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        pressureEmaEnabled: enabled,
        pressureChangeSpacingBoostEnabled: false,
        lowPressureDensityBoostEnabled: false,
        lowPressureAdaptiveSmoothingEnabled: false,
        trajectorySmoothingEnabled: false,
        maxDabIntervalMs: 1000,
      });
      stamper.processPoint(12, 0, 1, 6, true, {
        timestampMs: 12,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        pressureEmaEnabled: enabled,
        pressureChangeSpacingBoostEnabled: false,
        lowPressureDensityBoostEnabled: false,
        lowPressureAdaptiveSmoothingEnabled: false,
        trajectorySmoothingEnabled: false,
        maxDabIntervalMs: 1000,
      });
      const dabs = stamper.processPoint(24, 0, 0, 6, true, {
        timestampMs: 24,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        pressureEmaEnabled: enabled,
        pressureChangeSpacingBoostEnabled: false,
        lowPressureDensityBoostEnabled: false,
        lowPressureAdaptiveSmoothingEnabled: false,
        trajectorySmoothingEnabled: false,
        maxDabIntervalMs: 1000,
      });
      return dabs[0]?.pressure ?? 0;
    };

    expect(runPressureChangeSpacing(true)).toBeGreaterThan(runPressureChangeSpacing(false));
    expect(runLowPressureDensity(true)).toBeGreaterThan(runLowPressureDensity(false));
    expect(runPressureEma(true)).toBeGreaterThan(runPressureEma(false));
  });

  it('uses averaged stroke-start anchor to suppress start jitter spikes', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();

    const preMoveSamples = [
      { x: 100, y: 100, p: 0.6, t: 0 },
      { x: 100.3, y: 99.8, p: 0.6, t: 4 },
      { x: 100.7, y: 100.2, p: 0.6, t: 8 },
      // Outlier near threshold: should not pollute start anchor averaging.
      { x: 102.6, y: 100.1, p: 0.6, t: 12 },
    ];

    for (const sample of preMoveSamples) {
      const dabs = stamper.processPoint(sample.x, sample.y, sample.p, 2, false, {
        timestampMs: sample.t,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        trajectorySmoothingEnabled: true,
      });
      expect(dabs).toEqual([]);
    }

    const startTransitionDabs = stamper.processPoint(106, 100, 0.6, 2, false, {
      timestampMs: 16,
      maxBrushSpeedPxPerMs: 30,
      brushSpeedSmoothingSamples: 3,
      trajectorySmoothingEnabled: true,
    });

    expect(startTransitionDabs.length).toBeGreaterThanOrEqual(3);
    const first = startTransitionDabs[0];
    const last = startTransitionDabs[startTransitionDabs.length - 1];
    expect(first).toBeTruthy();
    expect(last).toBeTruthy();
    if (!first || !last) return;

    // Averaged anchor should stay near stable start cluster, not jump to the outlier.
    expect(first.x).toBeLessThan(101);
    expect(first.pressure).toBeLessThan(last.pressure);
    expect(last.pressure).toBeCloseTo(0.6, 2);
  });

  it('adaptive low-pressure smoothing reduces pressure stepping', () => {
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
        trajectorySmoothingEnabled: true,
      });
      adaptivePressures.push(...adaptiveDabs.map((dab) => dab.pressure));

      const baselineDabs = baseline.processPoint(x, 0, pressure, 2, false, {
        timestampMs,
        maxBrushSpeedPxPerMs: 1,
        brushSpeedSmoothingSamples: 3,
        lowPressureAdaptiveSmoothingEnabled: false,
        trajectorySmoothingEnabled: true,
      });
      baselinePressures.push(...baselineDabs.map((dab) => dab.pressure));
    }

    expect(adaptivePressures.length).toBeGreaterThan(2);
    expect(baselinePressures.length).toBeGreaterThan(2);
    expect(meanAdjacentDelta(adaptivePressures)).toBeLessThan(meanAdjacentDelta(baselinePressures));
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
        trajectorySmoothingEnabled: true,
      });
      mainDabs.push(...dabs);
    }

    const finalizeDabs = stamper.finishStroke(24, {
      maxBrushSpeedPxPerMs: 30,
      brushSpeedSmoothingSamples: 3,
      maxDabIntervalMs: 1,
      trajectorySmoothingEnabled: true,
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

    expect(finalizeDabs).toEqual([]);
    expect(snapshot?.reason).toBe('no_pending_segment');
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
        trajectorySmoothingEnabled: true,
      });
      stamper.processPoint(4, 0, 0.45, 6, false, {
        timestampMs: 8,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        maxDabIntervalMs,
        trajectorySmoothingEnabled: true,
      });

      let emitted = 0;
      for (let i = 0; i < 6; i += 1) {
        const dabs = stamper.processPoint(4 + (i + 1) * 0.08, 0, 0.45, 6, false, {
          timestampMs: 48 + i * 40,
          maxBrushSpeedPxPerMs: 30,
          brushSpeedSmoothingSamples: 3,
          maxDabIntervalMs,
          trajectorySmoothingEnabled: true,
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

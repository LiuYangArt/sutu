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

describe('BrushStamper speed-based smoothing and tail taper', () => {
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
      });
      expect(dabs).toEqual([]);
    }

    const startTransitionDabs = stamper.processPoint(106, 100, 0.6, 2, false, {
      timestampMs: 16,
      maxBrushSpeedPxPerMs: 30,
      brushSpeedSmoothingSamples: 3,
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
    expect(meanAdjacentDelta(adaptivePressures)).toBeLessThan(meanAdjacentDelta(baselinePressures));
  });

  it('generates converging tail dabs on the last real segment when taper is triggered', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();

    for (let i = 0; i < 9; i += 1) {
      stamper.processPoint(i * 6, 0, 0.4, 2, false, {
        timestampMs: i * 4,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        tailTaperEnabled: true,
      });
    }

    const tailDabs = stamper.finishStroke(24, { tailTaperEnabled: true });
    const snapshot = stamper.getTailTaperDebugSnapshot();
    expect(tailDabs.length).toBeGreaterThan(0);
    expect(snapshot).toBeTruthy();
    expect(snapshot?.reason).toBe('triggered');
    const first = tailDabs[0];
    const last = tailDabs[tailDabs.length - 1];
    expect(first).toBeTruthy();
    expect(last).toBeTruthy();
    if (!first || !last) return;

    for (let i = 1; i < tailDabs.length; i += 1) {
      expect(tailDabs[i]!.pressure).toBeLessThanOrEqual(tailDabs[i - 1]!.pressure + 1e-6);
    }
    expect(last.pressure).toBeCloseTo(0, 6);

    // Tail must stay inside the final real segment [42, 48] and never overshoot.
    for (const dab of tailDabs) {
      expect(dab.x).toBeGreaterThanOrEqual(42 - 1e-6);
      expect(dab.x).toBeLessThanOrEqual(48 + 1e-6);
      expect(dab.y).toBeCloseTo(0, 6);
    }
  });

  it('skips synthetic convergence when pressure already decays naturally', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();

    const pressures = [0.5, 0.42, 0.35, 0.24, 0.16, 0.08, 0.03];
    for (let i = 0; i < pressures.length; i += 1) {
      stamper.processPoint(i * 6, 0, pressures[i]!, 2, false, {
        timestampMs: i * 5,
        maxBrushSpeedPxPerMs: 100,
        brushSpeedSmoothingSamples: 3,
        tailTaperEnabled: true,
      });
    }

    const tailDabs = stamper.finishStroke(24, { tailTaperEnabled: true });
    const snapshot = stamper.getTailTaperDebugSnapshot();
    expect(tailDabs).toEqual([]);
    expect(snapshot?.reason).toBe('pressure_already_decaying');
  });
});

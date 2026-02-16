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

  it('generates monotonic tail dabs when fast lift-off keeps pressure high', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();

    for (let i = 0; i < 9; i += 1) {
      stamper.processPoint(i * 6, 0, 0.38, 2, false, {
        timestampMs: i * 5,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        tailTaperEnabled: true,
      });
    }

    const tailDabs = stamper.finishStroke(24, {
      tailTaperEnabled: true,
    });

    expect(tailDabs.length).toBeGreaterThan(0);
    for (let i = 1; i < tailDabs.length; i += 1) {
      expect(tailDabs[i]!.pressure).toBeLessThanOrEqual(tailDabs[i - 1]!.pressure + 1e-6);
    }
  });

  it('extends tail with enough samples to avoid short triangular caps', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();

    for (let i = 0; i < 10; i += 1) {
      stamper.processPoint(i * 6, 0, 0.42, 2, false, {
        timestampMs: i * 4,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        tailTaperEnabled: true,
      });
    }

    const brushSize = 24;
    const tailDabs = stamper.finishStroke(brushSize, {
      tailTaperEnabled: true,
    });

    expect(tailDabs.length).toBeGreaterThanOrEqual(7);
    const first = tailDabs[0];
    const last = tailDabs[tailDabs.length - 1];
    expect(first).toBeTruthy();
    expect(last).toBeTruthy();
    if (!first || !last) return;
    const tailDistance = Math.hypot(last.x - first.x, last.y - first.y);
    expect(tailDistance).toBeGreaterThan(brushSize * 0.5);

    for (let i = 1; i < tailDabs.length; i += 1) {
      const prev = tailDabs[i - 1]!;
      const curr = tailDabs[i]!;
      const gap = Math.hypot(curr.x - prev.x, curr.y - prev.y);
      const prevNominalDiameter = Math.max(1, brushSize * prev.pressure);
      expect(gap).toBeLessThanOrEqual(Math.max(0.9, prevNominalDiameter * 0.75));
    }
  });

  it('keeps first tail pressure close to stroke-end pressure for smooth handoff', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();

    for (let i = 0; i < 10; i += 1) {
      stamper.processPoint(i * 6, 0, 0.42, 2, false, {
        timestampMs: i * 4,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        tailTaperEnabled: true,
      });
    }

    const brushSize = 24;
    const tailDabs = stamper.finishStroke(brushSize, { tailTaperEnabled: true });
    const snapshot = stamper.getTailTaperDebugSnapshot();
    expect(snapshot?.reason).toBe('triggered');
    expect(tailDabs.length).toBeGreaterThan(0);

    const first = tailDabs[0];
    if (!first || !snapshot?.lastPressure) return;

    // Avoid abrupt pressure cliff at the start of tail.
    expect(first.pressure).toBeGreaterThan(snapshot.lastPressure * 0.8);

    // Tail should connect to stroke end without a visible detached jump.
    const endX = 9 * 6;
    const endY = 0;
    const joinGap = Math.hypot(first.x - endX, first.y - endY);
    expect(joinGap).toBeLessThanOrEqual(brushSize * 0.12);
  });

  it('enforces small-brush tail spacing floor to prevent dotted tails', () => {
    const stamper = new BrushStamper();
    stamper.beginStroke();

    for (let i = 0; i < 9; i += 1) {
      stamper.processPoint(i * 4, 0, 0.55, 1.5, false, {
        timestampMs: i * 2,
        maxBrushSpeedPxPerMs: 30,
        brushSpeedSmoothingSamples: 3,
        tailTaperEnabled: true,
      });
    }

    const tailDabs = stamper.finishStroke(2, { tailTaperEnabled: true });
    expect(tailDabs.length).toBeGreaterThanOrEqual(3);

    const gaps: number[] = [];
    for (let i = 1; i < tailDabs.length; i += 1) {
      const prev = tailDabs[i - 1]!;
      const curr = tailDabs[i]!;
      gaps.push(Math.hypot(curr.x - prev.x, curr.y - prev.y));
    }

    expect(Math.max(...gaps)).toBeLessThanOrEqual(0.85);
  });

  it('does not generate tail dabs when pressure already decays naturally', () => {
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
    expect(tailDabs).toEqual([]);
  });
});

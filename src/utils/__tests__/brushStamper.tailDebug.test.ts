import { describe, expect, it } from 'vitest';
import {
  BrushStamper,
  type StrokeFinalizeDebugSnapshot,
  type StrokeFinalizeReason,
} from '@/utils/strokeBuffer';
import strokeBufferSource from '@/utils/strokeBuffer.ts?raw';

function buildLinearPoints(count: number, stepX: number): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i += 1) {
    points.push({ x: i * stepX, y: 0 });
  }
  return points;
}

function runStrokeWithSamples(params: {
  points: Array<{ x: number; y: number }>;
  pressures: number[];
  timestampStepMs: number;
  maxBrushSpeedPxPerMs: number;
  spacingPx?: number;
  finishSpacingPx?: number;
  maxDabIntervalMs?: number;
  trajectorySmoothingEnabled?: boolean;
}): {
  finalizeDabs: Array<{ x: number; y: number; pressure: number }>;
  snapshot: StrokeFinalizeDebugSnapshot;
} {
  const stamper = new BrushStamper();
  stamper.beginStroke();
  const spacingPx = params.spacingPx ?? 2;

  for (let i = 0; i < params.points.length; i += 1) {
    const point = params.points[i]!;
    const pressure = params.pressures[i] ?? params.pressures[params.pressures.length - 1] ?? 0;
    stamper.processPoint(point.x, point.y, pressure, spacingPx, false, {
      timestampMs: i * params.timestampStepMs,
      maxBrushSpeedPxPerMs: params.maxBrushSpeedPxPerMs,
      brushSpeedSmoothingSamples: 3,
      maxDabIntervalMs: params.maxDabIntervalMs,
      trajectorySmoothingEnabled: params.trajectorySmoothingEnabled ?? true,
    });
  }

  const finalizeDabs = stamper.finishStroke(params.finishSpacingPx ?? 24, {
    maxBrushSpeedPxPerMs: params.maxBrushSpeedPxPerMs,
    brushSpeedSmoothingSamples: 3,
    maxDabIntervalMs: params.maxDabIntervalMs,
    trajectorySmoothingEnabled: params.trajectorySmoothingEnabled ?? true,
  });
  const snapshot = stamper.getStrokeFinalizeDebugSnapshot();
  if (!snapshot) {
    throw new Error('finalize debug snapshot must exist after finishStroke');
  }
  return { finalizeDabs, snapshot };
}

describe('BrushStamper finalize debug snapshot', () => {
  it.each<[StrokeFinalizeReason, () => StrokeFinalizeDebugSnapshot]>([
    [
      'no_active_stroke',
      () => {
        const stamper = new BrushStamper();
        stamper.finishStroke(24);
        return stamper.getStrokeFinalizeDebugSnapshot()!;
      },
    ],
    [
      'no_pending_segment',
      () =>
        runStrokeWithSamples({
          points: [{ x: 0, y: 0 }],
          pressures: [0.4],
          timestampStepMs: 5,
          maxBrushSpeedPxPerMs: 30,
        }).snapshot,
    ],
    [
      'segment_below_threshold',
      () =>
        runStrokeWithSamples({
          points: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 4.1, y: 0 },
            { x: 4.2, y: 0 },
          ],
          pressures: [0.4, 0.4, 0.4, 0.4],
          timestampStepMs: 1,
          maxBrushSpeedPxPerMs: 30,
          spacingPx: 4,
          finishSpacingPx: 24,
          maxDabIntervalMs: 1000,
        }).snapshot,
    ],
    [
      'emitted_segment',
      () =>
        runStrokeWithSamples({
          points: buildLinearPoints(8, 6),
          pressures: new Array(8).fill(0.4),
          timestampStepMs: 4,
          maxBrushSpeedPxPerMs: 30,
          maxDabIntervalMs: 1,
        }).snapshot,
    ],
  ])('records reason=%s', (reason, runCase) => {
    const snapshot = runCase();
    expect(snapshot.reason).toBe(reason);
    expect(snapshot.normalizedSpeed).toBeGreaterThanOrEqual(0);
    expect(snapshot.normalizedSpeed).toBeLessThanOrEqual(1);
    expect(snapshot.emittedDabCount).toBeGreaterThanOrEqual(0);
    expect(snapshot.remainingDistancePx).toBeGreaterThanOrEqual(0);
    expect(snapshot.remainingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps finalize dabs in the final real segment parameter domain', () => {
    const { finalizeDabs, snapshot } = runStrokeWithSamples({
      points: buildLinearPoints(9, 6),
      pressures: new Array(9).fill(0.42),
      timestampStepMs: 4,
      maxBrushSpeedPxPerMs: 30,
      maxDabIntervalMs: 1,
    });
    expect(snapshot.reason).toBe('emitted_segment');
    expect(finalizeDabs.length).toBeGreaterThan(0);
    for (const dab of finalizeDabs) {
      expect(dab.x).toBeGreaterThanOrEqual(42 - 1e-6);
      expect(dab.x).toBeLessThanOrEqual(48 + 1e-6);
      expect(dab.y).toBeCloseTo(0, 6);
    }
  });

  it('removes legacy tail-injection code path from strokeBuffer source', () => {
    const source = strokeBufferSource;

    expect(source).not.toMatch(/evaluateTailTaper/);
    expect(source).not.toMatch(/buildTailDabs/);

    const finishStart = source.indexOf('finishStroke(');
    const finishEnd = source.indexOf('getStrokeFinalizeDebugSnapshot');
    expect(finishStart).toBeGreaterThanOrEqual(0);
    expect(finishEnd).toBeGreaterThan(finishStart);
    const finishBody = source.slice(finishStart, finishEnd);
    expect(finishBody).not.toMatch(/pressure\s*:\s*0/);
  });
});

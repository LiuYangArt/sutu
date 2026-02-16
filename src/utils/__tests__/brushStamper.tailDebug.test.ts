import { describe, expect, it } from 'vitest';
import {
  BrushStamper,
  type TailTaperBlockReason,
  type TailTaperDebugSnapshot,
} from '@/utils/strokeBuffer';

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
  tailTaperEnabled?: boolean;
}): {
  tailDabs: Array<{ x: number; y: number; pressure: number }>;
  snapshot: TailTaperDebugSnapshot;
} {
  const stamper = new BrushStamper();
  stamper.beginStroke();

  for (let i = 0; i < params.points.length; i += 1) {
    const point = params.points[i]!;
    const pressure = params.pressures[i] ?? params.pressures[params.pressures.length - 1] ?? 0;
    stamper.processPoint(point.x, point.y, pressure, 2, false, {
      timestampMs: i * params.timestampStepMs,
      maxBrushSpeedPxPerMs: params.maxBrushSpeedPxPerMs,
      brushSpeedSmoothingSamples: 3,
      tailTaperEnabled: params.tailTaperEnabled ?? true,
    });
  }

  const tailDabs = stamper.finishStroke(24, {
    tailTaperEnabled: params.tailTaperEnabled ?? true,
    maxBrushSpeedPxPerMs: params.maxBrushSpeedPxPerMs,
    brushSpeedSmoothingSamples: 3,
  });
  const snapshot = stamper.getTailTaperDebugSnapshot();
  if (!snapshot) {
    throw new Error('tail debug snapshot must exist after finishStroke');
  }
  return { tailDabs, snapshot };
}

describe('BrushStamper tail taper debug snapshot', () => {
  it.each<[TailTaperBlockReason, () => TailTaperDebugSnapshot]>([
    [
      'disabled',
      () =>
        runStrokeWithSamples({
          points: buildLinearPoints(8, 6),
          pressures: new Array(8).fill(0.38),
          timestampStepMs: 5,
          maxBrushSpeedPxPerMs: 30,
          tailTaperEnabled: false,
        }).snapshot,
    ],
    [
      'insufficient_samples',
      () =>
        runStrokeWithSamples({
          points: buildLinearPoints(3, 6),
          pressures: [0.4, 0.4, 0.4],
          timestampStepMs: 5,
          maxBrushSpeedPxPerMs: 30,
        }).snapshot,
    ],
    [
      'missing_segment',
      () =>
        runStrokeWithSamples({
          points: [
            { x: 0, y: 0 },
            { x: 6, y: 0 },
            { x: 12, y: 0 },
            { x: 18, y: 0 },
            { x: 18, y: 0 },
            { x: 18, y: 0 },
          ],
          pressures: [0.35, 0.35, 0.35, 0.35, 0.35, 0.35],
          timestampStepMs: 5,
          maxBrushSpeedPxPerMs: 30,
        }).snapshot,
    ],
    [
      'speed_below_threshold',
      () =>
        runStrokeWithSamples({
          points: buildLinearPoints(8, 1),
          pressures: new Array(8).fill(0.35),
          timestampStepMs: 20,
          maxBrushSpeedPxPerMs: 100,
        }).snapshot,
    ],
    [
      'pressure_below_threshold',
      () =>
        runStrokeWithSamples({
          points: buildLinearPoints(8, 6),
          pressures: new Array(8).fill(0.02),
          timestampStepMs: 4,
          maxBrushSpeedPxPerMs: 30,
        }).snapshot,
    ],
    [
      'pressure_already_decaying',
      () =>
        runStrokeWithSamples({
          points: buildLinearPoints(8, 6),
          pressures: [0.95, 0.92, 0.9, 0.32, 0.2, 0.12, 0.08, 0.06],
          timestampStepMs: 4,
          maxBrushSpeedPxPerMs: 30,
        }).snapshot,
    ],
    [
      'triggered',
      () =>
        runStrokeWithSamples({
          points: buildLinearPoints(8, 6),
          pressures: new Array(8).fill(0.4),
          timestampStepMs: 4,
          maxBrushSpeedPxPerMs: 30,
        }).snapshot,
    ],
  ])('records reason=%s', (reason, runCase) => {
    const snapshot = runCase();
    expect(snapshot.reason).toBe(reason);
    expect(snapshot.sampleCount).toBeGreaterThanOrEqual(0);
    expect(snapshot.normalizedSpeed).toBeGreaterThanOrEqual(0);
    expect(snapshot.normalizedSpeed).toBeLessThanOrEqual(1);
  });

  it('keeps generated tail dabs when reason is triggered', () => {
    const { tailDabs, snapshot } = runStrokeWithSamples({
      points: buildLinearPoints(9, 6),
      pressures: new Array(9).fill(0.42),
      timestampStepMs: 4,
      maxBrushSpeedPxPerMs: 30,
    });
    expect(snapshot.reason).toBe('triggered');
    expect(tailDabs.length).toBeGreaterThan(0);
  });
});

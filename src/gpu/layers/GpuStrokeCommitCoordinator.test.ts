import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GpuStrokePrepareResult } from '../types';
import type { GpuCanvasRenderer } from './GpuCanvasRenderer';
import { GpuStrokeCommitCoordinator } from './GpuStrokeCommitCoordinator';

function makeScratchPrepareResult(): GpuStrokePrepareResult {
  return {
    dirtyRect: { left: 0, top: 0, right: 10, bottom: 10 },
    strokeOpacity: 1,
    scratch: {
      texture: {} as GPUTexture,
      renderScale: 1,
    },
  };
}

describe('GpuStrokeCommitCoordinator', () => {
  beforeEach(() => {
    let ms = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      ms += 10;
      return ms;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aggregates commit metrics for all commit outcomes', async () => {
    const commitStroke = vi.fn(() => [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    const readbackTilesToLayer = vi.fn(async () => undefined);
    const gpuRenderer = {
      commitStroke,
      readbackTilesToLayer,
    } as unknown as GpuCanvasRenderer;

    const prepareQueue: GpuStrokePrepareResult[] = [
      { dirtyRect: null, strokeOpacity: 1, scratch: null },
      makeScratchPrepareResult(),
      makeScratchPrepareResult(),
    ];
    const prepareStrokeEndGpu = vi.fn(
      async () => prepareQueue.shift() ?? makeScratchPrepareResult()
    );
    const clearScratchGpu = vi.fn();

    let layerAvailable = false;
    const getTargetLayer = vi.fn(() =>
      layerAvailable
        ? ({ canvas: {} as HTMLCanvasElement, ctx: {} as CanvasRenderingContext2D } as const)
        : null
    );

    const coordinator = new GpuStrokeCommitCoordinator({
      gpuRenderer,
      prepareStrokeEndGpu,
      clearScratchGpu,
      getTargetLayer,
    });

    await coordinator.commit('layer-1');
    await coordinator.commit('layer-1');
    layerAvailable = true;
    const success = await coordinator.commit('layer-1');

    expect(success.committed).toBe(true);
    expect(clearScratchGpu).toHaveBeenCalledTimes(3);
    expect(commitStroke).toHaveBeenCalledTimes(1);
    expect(readbackTilesToLayer).toHaveBeenCalledTimes(1);

    const snapshot = coordinator.getCommitMetricsSnapshot();
    expect(snapshot.attemptCount).toBe(3);
    expect(snapshot.committedCount).toBe(1);
    expect(snapshot.avgPrepareMs).toBeCloseTo(10);
    expect(snapshot.avgCommitMs).toBeCloseTo(10 / 3);
    expect(snapshot.avgReadbackMs).toBeCloseTo(10 / 3);
    expect(snapshot.avgTotalMs).toBeCloseTo((10 + 10 + 30) / 3);
    expect(snapshot.maxTotalMs).toBe(30);
    expect(snapshot.totalDirtyTiles).toBe(2);
    expect(snapshot.avgDirtyTiles).toBeCloseTo(2 / 3);
    expect(snapshot.maxDirtyTiles).toBe(2);
    expect(snapshot.lastCommitAtMs).toBe(130);

    coordinator.resetCommitMetrics();
    const resetSnapshot = coordinator.getCommitMetricsSnapshot();
    expect(resetSnapshot).toEqual({
      attemptCount: 0,
      committedCount: 0,
      avgPrepareMs: 0,
      avgCommitMs: 0,
      avgReadbackMs: 0,
      avgTotalMs: 0,
      maxTotalMs: 0,
      totalDirtyTiles: 0,
      avgDirtyTiles: 0,
      maxDirtyTiles: 0,
      lastCommitAtMs: null,
    });
  });
});

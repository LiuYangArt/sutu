import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GpuStrokePrepareResult } from '../types';
import type { GpuCanvasRenderer } from './GpuCanvasRenderer';
import { GpuStrokeCommitCoordinator } from './GpuStrokeCommitCoordinator';
import type { GpuStrokeHistoryStore } from './GpuStrokeHistoryStore';

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

  it('aggregates commit metrics for all commit outcomes and readback modes', async () => {
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
    coordinator.setReadbackMode('disabled');
    const successWithoutReadback = await coordinator.commit('layer-1');

    expect(success.committed).toBe(true);
    expect(successWithoutReadback.committed).toBe(true);
    expect(clearScratchGpu).toHaveBeenCalledTimes(4);
    expect(commitStroke).toHaveBeenCalledTimes(2);
    expect(readbackTilesToLayer).toHaveBeenCalledTimes(1);

    const snapshot = coordinator.getCommitMetricsSnapshot();
    expect(snapshot.attemptCount).toBe(4);
    expect(snapshot.committedCount).toBe(2);
    expect(snapshot.avgPrepareMs).toBeCloseTo(10);
    expect(snapshot.avgCommitMs).toBeCloseTo(20 / 4);
    expect(snapshot.avgReadbackMs).toBeCloseTo(10 / 4);
    expect(snapshot.avgTotalMs).toBeCloseTo((10 + 10 + 30 + 20) / 4);
    expect(snapshot.maxTotalMs).toBe(30);
    expect(snapshot.totalDirtyTiles).toBe(4);
    expect(snapshot.avgDirtyTiles).toBeCloseTo(1);
    expect(snapshot.maxDirtyTiles).toBe(2);
    expect(snapshot.lastCommitAtMs).toBe(180);
    expect(snapshot.readbackMode).toBe('disabled');
    expect(snapshot.readbackBypassedCount).toBe(1);

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
      readbackMode: 'disabled',
      readbackBypassedCount: 0,
    });
  });

  it('accumulates readbackBypassedCount across multiple disabled commits', async () => {
    const commitStroke = vi.fn(() => [{ x: 0, y: 0 }]);
    const readbackTilesToLayer = vi.fn(async () => undefined);
    const gpuRenderer = {
      commitStroke,
      readbackTilesToLayer,
    } as unknown as GpuCanvasRenderer;

    const prepareStrokeEndGpu = vi.fn(async () => makeScratchPrepareResult());
    const clearScratchGpu = vi.fn();
    const getTargetLayer = vi.fn(
      () => ({ canvas: {} as HTMLCanvasElement, ctx: {} as CanvasRenderingContext2D }) as const
    );

    const coordinator = new GpuStrokeCommitCoordinator({
      gpuRenderer,
      prepareStrokeEndGpu,
      clearScratchGpu,
      getTargetLayer,
    });

    coordinator.setReadbackMode('disabled');
    await coordinator.commit('layer-1');
    await coordinator.commit('layer-1');

    const snapshot = coordinator.getCommitMetricsSnapshot();
    expect(snapshot.attemptCount).toBe(2);
    expect(snapshot.committedCount).toBe(2);
    expect(snapshot.readbackMode).toBe('disabled');
    expect(snapshot.readbackBypassedCount).toBe(2);
    expect(readbackTilesToLayer).not.toHaveBeenCalled();
  });

  it('forwards history capture params and finalizes history entry', async () => {
    const commitStroke = vi.fn(() => [{ x: 0, y: 0 }]);
    const readbackTilesToLayer = vi.fn(async () => undefined);
    const gpuRenderer = {
      commitStroke,
      readbackTilesToLayer,
    } as unknown as GpuCanvasRenderer;

    const prepareStrokeEndGpu = vi.fn(async () => makeScratchPrepareResult());
    const clearScratchGpu = vi.fn();
    const getTargetLayer = vi.fn(
      () => ({ canvas: {} as HTMLCanvasElement, ctx: {} as CanvasRenderingContext2D }) as const
    );
    const historyStore = {
      finalizeStroke: vi.fn(),
    } as unknown as GpuStrokeHistoryStore;

    const coordinator = new GpuStrokeCommitCoordinator({
      gpuRenderer,
      prepareStrokeEndGpu,
      clearScratchGpu,
      getTargetLayer,
    });
    coordinator.setReadbackMode('disabled');

    const result = await coordinator.commit('layer-1', {
      historyEntryId: 'history-entry-1',
      historyStore,
    });

    expect(result.committed).toBe(true);
    expect(commitStroke).toHaveBeenCalledWith(
      expect.objectContaining({
        historyCapture: {
          entryId: 'history-entry-1',
          store: historyStore,
        },
      })
    );
    expect(historyStore.finalizeStroke).toHaveBeenCalledWith('history-entry-1');
  });
});

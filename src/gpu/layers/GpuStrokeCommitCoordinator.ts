import type { Rect } from '@/utils/strokeBuffer';
import type {
  GpuBrushCommitReadbackMode,
  GpuBrushCommitMetricsSnapshot,
  GpuStrokeCommitResult,
  GpuStrokePrepareResult,
} from '../types';
import type { GpuCanvasRenderer } from './GpuCanvasRenderer';
import type { GpuStrokeHistoryStore } from './GpuStrokeHistoryStore';

function hasDrawableDirtyRect(rect: Rect | null): rect is Rect {
  return Boolean(rect && rect.right > rect.left && rect.bottom > rect.top);
}

function emptyCommitResult(dirtyRect: Rect | null = null): GpuStrokeCommitResult {
  return {
    committed: false,
    dirtyRect,
    dirtyTiles: [],
    timings: {
      prepareMs: 0,
      commitMs: 0,
      readbackMs: 0,
    },
  };
}

export interface GpuStrokeCommitCoordinatorOptions {
  gpuRenderer: GpuCanvasRenderer;
  prepareStrokeEndGpu: () => Promise<GpuStrokePrepareResult>;
  clearScratchGpu: () => void;
  getTargetLayer: (
    layerId: string
  ) => { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null;
}

export interface GpuStrokeCommitOptions {
  historyEntryId?: string | null;
  historyStore?: GpuStrokeHistoryStore | null;
}

interface GpuCommitMetricsAccumulatorState {
  attemptCount: number;
  committedCount: number;
  totalPrepareMs: number;
  totalCommitMs: number;
  totalReadbackMs: number;
  totalElapsedMs: number;
  maxElapsedMs: number;
  totalDirtyTiles: number;
  maxDirtyTiles: number;
  lastCommitAtMs: number | null;
  readbackBypassedCount: number;
}

function createEmptyCommitMetricsState(): GpuCommitMetricsAccumulatorState {
  return {
    attemptCount: 0,
    committedCount: 0,
    totalPrepareMs: 0,
    totalCommitMs: 0,
    totalReadbackMs: 0,
    totalElapsedMs: 0,
    maxElapsedMs: 0,
    totalDirtyTiles: 0,
    maxDirtyTiles: 0,
    lastCommitAtMs: null,
    readbackBypassedCount: 0,
  };
}

export class GpuStrokeCommitCoordinator {
  private gpuRenderer: GpuCanvasRenderer;
  private prepareStrokeEndGpu: () => Promise<GpuStrokePrepareResult>;
  private clearScratchGpu: () => void;
  private getTargetLayer: (
    layerId: string
  ) => { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null;
  private metrics: GpuCommitMetricsAccumulatorState = createEmptyCommitMetricsState();
  private readbackMode: GpuBrushCommitReadbackMode = 'enabled';

  constructor(options: GpuStrokeCommitCoordinatorOptions) {
    this.gpuRenderer = options.gpuRenderer;
    this.prepareStrokeEndGpu = options.prepareStrokeEndGpu;
    this.clearScratchGpu = options.clearScratchGpu;
    this.getTargetLayer = options.getTargetLayer;
  }

  setReadbackMode(mode: GpuBrushCommitReadbackMode): void {
    this.readbackMode = mode;
  }

  getReadbackMode(): GpuBrushCommitReadbackMode {
    return this.readbackMode;
  }

  getCommitMetricsSnapshot(): GpuBrushCommitMetricsSnapshot {
    const attempts = this.metrics.attemptCount;
    const avgOrZero = (total: number) => (attempts > 0 ? total / attempts : 0);

    return {
      attemptCount: attempts,
      committedCount: this.metrics.committedCount,
      avgPrepareMs: avgOrZero(this.metrics.totalPrepareMs),
      avgCommitMs: avgOrZero(this.metrics.totalCommitMs),
      avgReadbackMs: avgOrZero(this.metrics.totalReadbackMs),
      avgTotalMs: avgOrZero(this.metrics.totalElapsedMs),
      maxTotalMs: this.metrics.maxElapsedMs,
      totalDirtyTiles: this.metrics.totalDirtyTiles,
      avgDirtyTiles: avgOrZero(this.metrics.totalDirtyTiles),
      maxDirtyTiles: this.metrics.maxDirtyTiles,
      lastCommitAtMs: this.metrics.lastCommitAtMs,
      readbackMode: this.readbackMode,
      readbackBypassedCount: this.metrics.readbackBypassedCount,
    };
  }

  resetCommitMetrics(): void {
    this.metrics = createEmptyCommitMetricsState();
  }

  private recordCommitSample(result: GpuStrokeCommitResult): void {
    const { prepareMs, commitMs, readbackMs } = result.timings;
    const totalMs = prepareMs + commitMs + readbackMs;
    const dirtyTiles = result.dirtyTiles.length;

    this.metrics.attemptCount += 1;
    if (result.committed) {
      this.metrics.committedCount += 1;
    }

    this.metrics.totalPrepareMs += prepareMs;
    this.metrics.totalCommitMs += commitMs;
    this.metrics.totalReadbackMs += readbackMs;
    this.metrics.totalElapsedMs += totalMs;
    this.metrics.maxElapsedMs = Math.max(this.metrics.maxElapsedMs, totalMs);

    this.metrics.totalDirtyTiles += dirtyTiles;
    this.metrics.maxDirtyTiles = Math.max(this.metrics.maxDirtyTiles, dirtyTiles);
    this.metrics.lastCommitAtMs = performance.now();
  }

  async commit(
    layerId: string | null,
    options: GpuStrokeCommitOptions = {}
  ): Promise<GpuStrokeCommitResult> {
    const historyEntryId = options.historyEntryId ?? null;
    const historyStore = options.historyStore ?? null;
    const finalizeHistory = () => {
      if (historyStore && historyEntryId) {
        historyStore.finalizeStroke(historyEntryId);
      }
    };

    try {
      const prepareStart = performance.now();
      const prepareResult = await this.prepareStrokeEndGpu();
      const prepareMs = performance.now() - prepareStart;

      if (!layerId || !prepareResult.scratch || !hasDrawableDirtyRect(prepareResult.dirtyRect)) {
        this.clearScratchGpu();
        const result = {
          ...emptyCommitResult(prepareResult.dirtyRect),
          timings: { prepareMs, commitMs: 0, readbackMs: 0 },
        };
        this.recordCommitSample(result);
        return result;
      }

      const layer = this.getTargetLayer(layerId);
      if (!layer) {
        this.clearScratchGpu();
        console.warn('[GpuStrokeCommitCoordinator] Missing target layer', { layerId });
        const result = {
          ...emptyCommitResult(prepareResult.dirtyRect),
          timings: { prepareMs, commitMs: 0, readbackMs: 0 },
        };
        this.recordCommitSample(result);
        return result;
      }

      const commitStart = performance.now();
      const dirtyTiles = this.gpuRenderer.commitStroke({
        layerId,
        scratchTexture: prepareResult.scratch.texture,
        dirtyRect: prepareResult.dirtyRect,
        strokeOpacity: prepareResult.strokeOpacity,
        renderScale: prepareResult.scratch.renderScale,
        applyDither: true,
        ditherStrength: 1.0,
        baseLayerCanvas: layer.canvas,
        historyCapture:
          historyStore && historyEntryId
            ? {
                entryId: historyEntryId,
                store: historyStore,
              }
            : undefined,
      });
      const commitMs = performance.now() - commitStart;

      let readbackMs = 0;
      if (dirtyTiles.length > 0 && this.readbackMode === 'enabled') {
        const readbackStart = performance.now();
        await this.gpuRenderer.readbackTilesToLayer({
          layerId,
          tiles: dirtyTiles,
          targetCtx: layer.ctx,
        });
        readbackMs = performance.now() - readbackStart;
      } else if (dirtyTiles.length > 0) {
        this.metrics.readbackBypassedCount += 1;
      }

      this.clearScratchGpu();

      const result = {
        committed: dirtyTiles.length > 0,
        dirtyRect: prepareResult.dirtyRect,
        dirtyTiles,
        timings: {
          prepareMs,
          commitMs,
          readbackMs,
        },
      };

      this.recordCommitSample(result);
      return result;
    } finally {
      finalizeHistory();
    }
  }
}

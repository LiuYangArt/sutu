import type { Rect } from '@/utils/strokeBuffer';
import type { GpuStrokeCommitResult, GpuStrokePrepareResult } from '../types';
import type { GpuCanvasRenderer } from './GpuCanvasRenderer';

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

export class GpuStrokeCommitCoordinator {
  private gpuRenderer: GpuCanvasRenderer;
  private prepareStrokeEndGpu: () => Promise<GpuStrokePrepareResult>;
  private clearScratchGpu: () => void;
  private getTargetLayer: (
    layerId: string
  ) => { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null;

  constructor(options: GpuStrokeCommitCoordinatorOptions) {
    this.gpuRenderer = options.gpuRenderer;
    this.prepareStrokeEndGpu = options.prepareStrokeEndGpu;
    this.clearScratchGpu = options.clearScratchGpu;
    this.getTargetLayer = options.getTargetLayer;
  }

  async commit(layerId: string | null): Promise<GpuStrokeCommitResult> {
    const prepareStart = performance.now();
    const prepareResult = await this.prepareStrokeEndGpu();
    const prepareMs = performance.now() - prepareStart;

    if (!layerId || !prepareResult.scratch || !hasDrawableDirtyRect(prepareResult.dirtyRect)) {
      this.clearScratchGpu();
      return {
        ...emptyCommitResult(prepareResult.dirtyRect),
        timings: { prepareMs, commitMs: 0, readbackMs: 0 },
      };
    }

    const layer = this.getTargetLayer(layerId);
    if (!layer) {
      this.clearScratchGpu();
      console.warn('[GpuStrokeCommitCoordinator] Missing target layer', { layerId });
      return {
        ...emptyCommitResult(prepareResult.dirtyRect),
        timings: { prepareMs, commitMs: 0, readbackMs: 0 },
      };
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
    });
    const commitMs = performance.now() - commitStart;

    let readbackMs = 0;
    if (dirtyTiles.length > 0) {
      const readbackStart = performance.now();
      await this.gpuRenderer.readbackTilesToLayer({
        layerId,
        tiles: dirtyTiles,
        targetCtx: layer.ctx,
      });
      readbackMs = performance.now() - readbackStart;
    }

    this.clearScratchGpu();

    return {
      committed: dirtyTiles.length > 0,
      dirtyRect: prepareResult.dirtyRect,
      dirtyTiles,
      timings: {
        prepareMs,
        commitMs,
        readbackMs,
      },
    };
  }
}

import { GpuCanvasRenderer } from '../layers/GpuCanvasRenderer';
import { TileResidencyManager } from '../layers/TileResidencyManager';

export interface TileSizeCompareOptions {
  canvasSize?: number;
  tileSizes?: number[];
  frames?: number;
  budgetRatio?: number;
  viewportTiles?: number;
}

export interface TileSizeCompareEntry {
  tileSize: number;
  tilesX: number;
  tilesY: number;
  totalTiles: number;
  bytesPerTile: number;
  budgetTiles: number;
  budgetBytes: number;
  lruHits: number;
  lruMisses: number;
  lruEvictions: number;
  lruMissRate: number;
  uploadMs: number;
  renderCpuMsAvg: number;
  renderGpuMsAvg: number;
}

export interface TileSizeCompareResult {
  canvasSize: number;
  frames: number;
  budgetRatio: number;
  viewportTiles: number;
  results: TileSizeCompareEntry[];
}

const DEFAULT_CANVAS_SIZE = 4096;
const DEFAULT_TILE_SIZES = [256, 512];
const DEFAULT_FRAMES = 20;
const DEFAULT_BUDGET_RATIO = 0.25;
const DEFAULT_VIEWPORT_TILES = 4;

function createPatternCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const grad = ctx.createLinearGradient(0, 0, size, 0);
  grad.addColorStop(0, '#000000');
  grad.addColorStop(1, '#ffffff');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const radial = ctx.createRadialGradient(
    size * 0.5,
    size * 0.5,
    size * 0.1,
    size * 0.5,
    size * 0.5,
    size * 0.6
  );
  radial.addColorStop(0, 'rgba(255,255,255,0.2)');
  radial.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, size, size);

  return canvas;
}

function simulateLruAccess(args: {
  tilesX: number;
  tilesY: number;
  tileSize: number;
  budgetRatio: number;
  viewportTiles: number;
}): {
  hits: number;
  misses: number;
  evictions: number;
  budgetTiles: number;
  budgetBytes: number;
} {
  const { tilesX, tilesY, tileSize, budgetRatio, viewportTiles } = args;
  const totalTiles = tilesX * tilesY;
  const bytesPerTile = tileSize * tileSize * 4;
  const budgetTiles = Math.max(1, Math.floor(totalTiles * budgetRatio));
  const budgetBytes = budgetTiles * bytesPerTile;
  const viewX = Math.max(1, Math.min(viewportTiles, tilesX));
  const viewY = Math.max(1, Math.min(viewportTiles, tilesY));

  const residency = new TileResidencyManager(budgetBytes);
  let hits = 0;
  let misses = 0;

  function accessViewport(startX: number, startY: number): void {
    for (let y = 0; y < viewY; y += 1) {
      for (let x = 0; x < viewX; x += 1) {
        const key = `${startX + x}_${startY + y}`;
        if (residency.has(key)) {
          hits += 1;
          residency.touch(key);
        } else {
          misses += 1;
          residency.registerTile(key, bytesPerTile, () => {});
        }
      }
    }
  }

  for (let pass = 0; pass < 2; pass += 1) {
    const forward = pass === 0;
    const yRange: [number, number, number] = forward
      ? [0, tilesY - viewY + 1, 1]
      : [tilesY - viewY, -1, -1];
    const xRange: [number, number, number] = forward
      ? [0, tilesX - viewX + 1, 1]
      : [tilesX - viewX, -1, -1];

    for (let y = yRange[0]; y !== yRange[1]; y += yRange[2]) {
      for (let x = xRange[0]; x !== xRange[1]; x += xRange[2]) {
        accessViewport(x, y);
      }
    }
  }

  return {
    hits,
    misses,
    evictions: residency.getEvictionCount(),
    budgetTiles,
    budgetBytes,
  };
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export async function runTileSizeCompare(
  device: GPUDevice,
  options: TileSizeCompareOptions = {}
): Promise<TileSizeCompareResult> {
  const canvasSize = options.canvasSize ?? DEFAULT_CANVAS_SIZE;
  const tileSizes = options.tileSizes ?? DEFAULT_TILE_SIZES;
  const frames = options.frames ?? DEFAULT_FRAMES;
  const budgetRatio = options.budgetRatio ?? DEFAULT_BUDGET_RATIO;
  const viewportTiles = options.viewportTiles ?? DEFAULT_VIEWPORT_TILES;

  const patternCanvas = createPatternCanvas(canvasSize);
  const results: TileSizeCompareEntry[] = [];

  for (const tileSize of tileSizes) {
    const tilesX = Math.ceil(canvasSize / tileSize);
    const tilesY = Math.ceil(canvasSize / tileSize);
    const totalTiles = tilesX * tilesY;
    const bytesPerTile = tileSize * tileSize * 4;

    const lru = simulateLruAccess({
      tilesX,
      tilesY,
      tileSize,
      budgetRatio,
      viewportTiles,
    });

    const gpuCanvas = document.createElement('canvas');
    gpuCanvas.width = canvasSize;
    gpuCanvas.height = canvasSize;

    const renderer = new GpuCanvasRenderer(device, gpuCanvas, {
      tileSize,
      layerFormat: 'rgba8unorm',
    });

    const layerId = `bench-layer-${tileSize}`;

    const uploadStart = performance.now();
    renderer.syncLayerFromCanvas(layerId, patternCanvas, 1);
    await device.queue.onSubmittedWorkDone();
    const uploadMs = performance.now() - uploadStart;

    const cpuTimes: number[] = [];
    const gpuTimes: number[] = [];

    await device.queue.onSubmittedWorkDone();
    for (let i = 0; i < frames; i += 1) {
      const cpuStart = performance.now();
      renderer.renderFrame({
        layerId,
        scratchTexture: null,
        strokeOpacity: 1,
        renderScale: 1,
      });
      const cpuEnd = performance.now();
      cpuTimes.push(cpuEnd - cpuStart);

      const gpuStart = performance.now();
      await device.queue.onSubmittedWorkDone();
      const gpuEnd = performance.now();
      gpuTimes.push(gpuEnd - gpuStart);
    }

    results.push({
      tileSize,
      tilesX,
      tilesY,
      totalTiles,
      bytesPerTile,
      budgetTiles: lru.budgetTiles,
      budgetBytes: lru.budgetBytes,
      lruHits: lru.hits,
      lruMisses: lru.misses,
      lruEvictions: lru.evictions,
      lruMissRate: lru.misses / Math.max(1, lru.hits + lru.misses),
      uploadMs,
      renderCpuMsAvg: average(cpuTimes),
      renderGpuMsAvg: average(gpuTimes),
    });
  }

  return {
    canvasSize,
    frames,
    budgetRatio,
    viewportTiles,
    results,
  };
}

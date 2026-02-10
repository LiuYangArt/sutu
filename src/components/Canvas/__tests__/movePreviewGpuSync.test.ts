import { describe, expect, it, vi } from 'vitest';
import {
  collectTileCoordsForRect,
  runGpuMovePreviewFrame,
  type PendingMovePreviewRestore,
} from '../movePreviewGpuSync';

type TestLayer = {
  id: string;
  revision: number;
};

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

describe('movePreviewGpuSync', () => {
  it('collectTileCoordsForRect clips to canvas and resolves touched tiles', () => {
    const tiles = collectTileCoordsForRect(
      { left: -10, top: 30, right: 130, bottom: 100 },
      128,
      128,
      64
    );
    expect(tiles).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
  });

  it('syncs move preview tiles and renders in same frame', () => {
    const calls: string[] = [];
    const layerA = createCanvas(128, 128);
    const layerB = createCanvas(128, 128);
    const previewCanvas = createCanvas(128, 128);

    const gpuRenderer = {
      syncLayerTilesFromCanvas: vi.fn((layerId: string, _canvas: HTMLCanvasElement, tiles) => {
        calls.push(`tiles:${layerId}:${tiles.length}`);
      }),
      syncLayerFromCanvas: vi.fn((layerId: string) => {
        calls.push(`full:${layerId}`);
      }),
    };

    const layerCanvasMap = new Map<string, HTMLCanvasElement>([
      ['layer-a', layerA],
      ['layer-b', layerB],
    ]);

    const pending = runGpuMovePreviewFrame<TestLayer>({
      gpuRenderer,
      visibleLayers: [
        { id: 'layer-a', revision: 1 },
        { id: 'layer-b', revision: 2 },
      ],
      movePreview: {
        layerId: 'layer-b',
        canvas: previewCanvas,
        dirtyRect: { left: 32, top: 0, right: 96, bottom: 64 },
      },
      pendingRestore: null,
      getLayerCanvas: (layerId) => layerCanvasMap.get(layerId) ?? null,
      width: 128,
      height: 128,
      tileSize: 64,
      onRender: () => {
        calls.push('render');
      },
    });

    expect(calls).toEqual(['full:layer-a', 'tiles:layer-b:2', 'render']);
    expect(pending).toEqual<PendingMovePreviewRestore>({
      layerId: 'layer-b',
      dirtyRect: { left: 32, top: 0, right: 96, bottom: 64 },
    });
  });

  it('restores authoritative tiles before regular sync when preview ends', () => {
    const calls: string[] = [];
    const layerA = createCanvas(128, 128);
    const layerB = createCanvas(128, 128);
    const layerCanvasMap = new Map<string, HTMLCanvasElement>([
      ['layer-a', layerA],
      ['layer-b', layerB],
    ]);

    const gpuRenderer = {
      syncLayerTilesFromCanvas: vi.fn((layerId: string, canvas: HTMLCanvasElement, tiles) => {
        const source = canvas === layerB ? 'authoritative' : 'unexpected';
        calls.push(`tiles:${layerId}:${source}:${tiles.length}`);
      }),
      syncLayerFromCanvas: vi.fn((layerId: string) => {
        calls.push(`full:${layerId}`);
      }),
    };

    const pending = runGpuMovePreviewFrame<TestLayer>({
      gpuRenderer,
      visibleLayers: [
        { id: 'layer-a', revision: 3 },
        { id: 'layer-b', revision: 4 },
      ],
      movePreview: null,
      pendingRestore: {
        layerId: 'layer-b',
        dirtyRect: { left: 512, top: 512, right: 768, bottom: 768 },
      },
      getLayerCanvas: (layerId) => layerCanvasMap.get(layerId) ?? null,
      width: 128,
      height: 128,
      tileSize: 64,
      onRender: () => {
        calls.push('render');
      },
    });

    expect(calls[0]).toBe('tiles:layer-b:authoritative:4');
    expect(calls).toEqual([
      'tiles:layer-b:authoritative:4',
      'full:layer-a',
      'full:layer-b',
      'render',
    ]);
    expect(pending).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMoveTool } from '../useMoveTool';
import { useSelectionStore } from '@/stores/selection';
import type { Layer } from '@/stores/document';
import { LayerRenderer } from '@/utils/layerRenderer';

type MockContext2D = CanvasRenderingContext2D & {
  getImageData: ReturnType<typeof vi.fn>;
};

function createMockContext(canvas: HTMLCanvasElement): MockContext2D {
  const ctx = {
    canvas,
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn((_x = 0, _y = 0, w = canvas.width, h = canvas.height) => {
      const width = Math.max(1, Math.floor(Number(w) || 1));
      const height = Math.max(1, Math.floor(Number(h) || 1));
      return new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
    }),
    putImageData: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    globalCompositeOperation: 'source-over',
    fillStyle: '#fff',
  } as unknown as MockContext2D;
  return ctx;
}

function makeLayerCanvas(id: string, width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as MockContext2D;
  return {
    id,
    canvas,
    ctx,
    visible: true,
    opacity: 100,
    blendMode: 'normal',
    isBackground: false,
  };
}

function flushAsync(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

describe('useMoveTool', () => {
  beforeEach(() => {
    useSelectionStore.getState().deselectAll();

    vi.spyOn(HTMLCanvasElement.prototype as any, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement
    ) {
      const key = '__paintboard_ctx__' as const;
      const self = this as HTMLCanvasElement & { __paintboard_ctx__?: MockContext2D };
      if (!self[key]) {
        self[key] = createMockContext(this);
      }
      return self[key] as unknown as CanvasRenderingContext2D;
    } as any);
  });

  afterEach(() => {
    useSelectionStore.getState().deselectAll();
    vi.restoreAllMocks();
  });

  it('Ctrl+click picks top-most visible layer by alpha', async () => {
    const width = 32;
    const height = 32;
    const bottomLayer = makeLayerCanvas('bottom', width, height);
    const topLayer = makeLayerCanvas('top', width, height);
    topLayer.ctx.getImageData.mockReturnValueOnce(
      new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1)
    );

    const layerMap = new Map([
      ['bottom', bottomLayer],
      ['top', topLayer],
    ]);
    const renderer = {
      getLayer: vi.fn((id: string) => layerMap.get(id)),
    } as unknown as LayerRenderer;

    const setActiveLayer = vi.fn();
    const { result } = renderHook(() =>
      useMoveTool({
        layerRendererRef: { current: renderer },
        currentTool: 'move',
        layers: [
          { id: 'bottom', visible: true, opacity: 100 } as Layer,
          { id: 'top', visible: true, opacity: 100 } as Layer,
        ],
        activeLayerId: 'bottom',
        width,
        height,
        setActiveLayer,
        syncAllPendingGpuLayersToCpu: vi.fn(async () => 0),
        captureBeforeImage: vi.fn(async () => undefined),
        saveStrokeToHistory: vi.fn(),
        markLayerDirty: vi.fn(),
        compositeAndRender: vi.fn(),
        updateThumbnail: vi.fn(),
      })
    );

    act(() => {
      result.current.handleMovePointerDown(10, 10, { ctrlKey: true, pointerId: 1 });
    });
    await act(async () => {
      await flushAsync();
    });

    expect(setActiveLayer).toHaveBeenCalledWith('top');
  });

  it('dragging without selection saves one stroke history entry', async () => {
    const width = 32;
    const height = 32;
    const layerA = makeLayerCanvas('layerA', width, height);
    const renderer = {
      getLayer: vi.fn(() => layerA),
    } as unknown as LayerRenderer;

    const captureBeforeImage = vi.fn(async () => undefined);
    const saveStrokeToHistory = vi.fn();
    const updateThumbnail = vi.fn();

    const { result } = renderHook(() =>
      useMoveTool({
        layerRendererRef: { current: renderer },
        currentTool: 'move',
        layers: [{ id: 'layerA', visible: true, locked: false, opacity: 100 } as Layer],
        activeLayerId: 'layerA',
        width,
        height,
        setActiveLayer: vi.fn(),
        syncAllPendingGpuLayersToCpu: vi.fn(async () => 0),
        captureBeforeImage,
        saveStrokeToHistory,
        markLayerDirty: vi.fn(),
        compositeAndRender: vi.fn(),
        updateThumbnail,
      })
    );

    act(() => {
      result.current.handleMovePointerDown(4, 4, { ctrlKey: false, pointerId: 7 });
    });
    await act(async () => {
      await flushAsync();
    });

    act(() => {
      result.current.handleMovePointerMove(12, 9, { pointerId: 7 });
      result.current.handleMovePointerUp(12, 9, { pointerId: 7 });
    });

    expect(captureBeforeImage).toHaveBeenCalledWith(false);
    expect(saveStrokeToHistory).toHaveBeenCalledTimes(1);
    expect(saveStrokeToHistory).toHaveBeenCalledWith();
    expect(updateThumbnail).toHaveBeenCalledWith('layerA');
  });

  it('dragging with selection saves selection before/after snapshots', async () => {
    const width = 32;
    const height = 32;
    const layerA = makeLayerCanvas('layerA', width, height);
    const renderer = {
      getLayer: vi.fn(() => layerA),
    } as unknown as LayerRenderer;

    const maskData = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < maskData.length; i += 4) {
      maskData[i + 3] = 255;
    }
    useSelectionStore.setState({
      hasSelection: true,
      selectionMask: new ImageData(maskData, width, height),
      selectionMaskPending: false,
      selectionPath: [
        [
          { x: 2, y: 2, type: 'polygonal' },
          { x: 8, y: 2, type: 'polygonal' },
          { x: 8, y: 8, type: 'polygonal' },
          { x: 2, y: 8, type: 'polygonal' },
          { x: 2, y: 2, type: 'polygonal' },
        ],
      ],
      bounds: { x: 2, y: 2, width: 6, height: 6 },
    });

    const saveStrokeToHistory = vi.fn();
    const { result } = renderHook(() =>
      useMoveTool({
        layerRendererRef: { current: renderer },
        currentTool: 'move',
        layers: [{ id: 'layerA', visible: true, locked: false, opacity: 100 } as Layer],
        activeLayerId: 'layerA',
        width,
        height,
        setActiveLayer: vi.fn(),
        syncAllPendingGpuLayersToCpu: vi.fn(async () => 0),
        captureBeforeImage: vi.fn(async () => undefined),
        saveStrokeToHistory,
        markLayerDirty: vi.fn(),
        compositeAndRender: vi.fn(),
        updateThumbnail: vi.fn(),
      })
    );

    act(() => {
      result.current.handleMovePointerDown(3, 3, { ctrlKey: false, pointerId: 11 });
    });
    await act(async () => {
      await flushAsync();
    });

    act(() => {
      result.current.handleMovePointerMove(10, 7, { pointerId: 11 });
      result.current.handleMovePointerUp(10, 7, { pointerId: 11 });
    });

    expect(saveStrokeToHistory).toHaveBeenCalledTimes(1);
    const payload = saveStrokeToHistory.mock.calls[0]?.[0];
    expect(payload?.selectionBefore).toBeTruthy();
    expect(payload?.selectionAfter).toBeTruthy();
  });
});

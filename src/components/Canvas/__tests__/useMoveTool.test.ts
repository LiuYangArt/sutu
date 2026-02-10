import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
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

async function flushAsync(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function buildSelectionMask(width: number, height: number): ImageData {
  const maskData = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < maskData.length; i += 4) {
    maskData[i + 3] = 255;
  }
  return new ImageData(maskData, width, height);
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

  it('does not block preview on captureBeforeImage; save waits for capture completion', async () => {
    const width = 32;
    const height = 32;
    const layerA = makeLayerCanvas('layerA', width, height);
    const renderer = {
      getLayer: vi.fn(() => layerA),
    } as unknown as LayerRenderer;

    let resolveCapture: (() => void) | null = null;
    const captureBeforeImage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCapture = resolve;
        })
    );
    const saveStrokeToHistory = vi.fn();
    const compositeAndRender = vi.fn();

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
        compositeAndRender,
        updateThumbnail: vi.fn(),
      })
    );

    act(() => {
      result.current.handleMovePointerDown(4, 4, { ctrlKey: false, pointerId: 7 });
      result.current.handleMovePointerUp(12, 10, { pointerId: 7 });
    });

    const hasMovePreviewCallBeforeCaptureDone = compositeAndRender.mock.calls.some((call) => {
      const payload = call[0] as
        | { movePreview?: { layerId: string }; clipRect?: { left: number; top: number } }
        | undefined;
      return payload?.movePreview?.layerId === 'layerA';
    });
    expect(hasMovePreviewCallBeforeCaptureDone).toBe(true);
    expect(saveStrokeToHistory).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(captureBeforeImage).toHaveBeenCalledWith(false);
      expect(resolveCapture).toBeTypeOf('function');
    });
    act(() => {
      resolveCapture?.();
    });
    await act(async () => {
      await flushAsync(8);
    });

    await waitFor(() => {
      expect(saveStrokeToHistory).toHaveBeenCalledTimes(1);
    });
  });

  it('selection drag uses composite injection movePreview instead of writing layer during preview', async () => {
    const width = 32;
    const height = 32;
    const layerA = makeLayerCanvas('layerA', width, height);
    const renderer = {
      getLayer: vi.fn(() => layerA),
    } as unknown as LayerRenderer;

    useSelectionStore.setState({
      hasSelection: true,
      selectionMask: buildSelectionMask(width, height),
      selectionMaskPending: false,
      selectionPath: [
        [
          { x: 2, y: 2, type: 'polygonal' },
          { x: 10, y: 2, type: 'polygonal' },
          { x: 10, y: 10, type: 'polygonal' },
          { x: 2, y: 10, type: 'polygonal' },
          { x: 2, y: 2, type: 'polygonal' },
        ],
      ],
      bounds: { x: 2, y: 2, width: 8, height: 8 },
    });

    const compositeAndRender = vi.fn();

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
        saveStrokeToHistory: vi.fn(),
        markLayerDirty: vi.fn(),
        compositeAndRender,
        updateThumbnail: vi.fn(),
      })
    );

    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    act(() => {
      result.current.handleMovePointerDown(4, 4, { ctrlKey: false, pointerId: 51 });
      result.current.handleMovePointerMove(14, 14, { pointerId: 51 });
    });

    const hasMovePreviewCall = compositeAndRender.mock.calls.some((call) => {
      const payload = call[0] as
        | { movePreview?: { layerId: string }; clipRect?: { left: number; top: number } }
        | undefined;
      return payload?.movePreview?.layerId === 'layerA';
    });
    expect(hasMovePreviewCall).toBe(true);

    const previewDrawCount = (layerA.ctx.drawImage as unknown as ReturnType<typeof vi.fn>).mock
      .calls.length;
    expect(previewDrawCount).toBe(0);

    rafSpy.mockRestore();
    cancelSpy.mockRestore();
  });

  it('saves selection before/after snapshots after capture resolved', async () => {
    const width = 24;
    const height = 24;
    const layerA = makeLayerCanvas('layerA', width, height);
    const renderer = {
      getLayer: vi.fn(() => layerA),
    } as unknown as LayerRenderer;

    useSelectionStore.setState({
      hasSelection: true,
      selectionMask: buildSelectionMask(width, height),
      selectionMaskPending: false,
      selectionPath: [
        [
          { x: 1, y: 1, type: 'polygonal' },
          { x: 8, y: 1, type: 'polygonal' },
          { x: 8, y: 8, type: 'polygonal' },
          { x: 1, y: 8, type: 'polygonal' },
          { x: 1, y: 1, type: 'polygonal' },
        ],
      ],
      bounds: { x: 1, y: 1, width: 7, height: 7 },
    });

    let resolveCapture: (() => void) | null = null;
    const captureBeforeImage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCapture = resolve;
        })
    );
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
        captureBeforeImage,
        saveStrokeToHistory,
        markLayerDirty: vi.fn(),
        compositeAndRender: vi.fn(),
        updateThumbnail: vi.fn(),
      })
    );

    act(() => {
      result.current.handleMovePointerDown(2, 2, { ctrlKey: false, pointerId: 21 });
      result.current.handleMovePointerUp(9, 9, { pointerId: 21 });
    });

    expect(saveStrokeToHistory).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(captureBeforeImage).toHaveBeenCalledWith(false);
      expect(resolveCapture).toBeTypeOf('function');
    });
    act(() => {
      resolveCapture?.();
    });
    await act(async () => {
      await flushAsync(8);
    });

    await waitFor(() => {
      expect(saveStrokeToHistory).toHaveBeenCalledTimes(1);
    });
    const payload = saveStrokeToHistory.mock.calls[0]?.[0];
    expect(payload?.selectionBefore).toBeTruthy();
    expect(payload?.selectionAfter).toBeTruthy();
  });

  it('passes clipped dirty rect during preview', async () => {
    const width = 32;
    const height = 32;
    const layerA = makeLayerCanvas('layerA', width, height);
    const renderer = {
      getLayer: vi.fn(() => layerA),
    } as unknown as LayerRenderer;

    const compositeAndRender = vi.fn();

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
        saveStrokeToHistory: vi.fn(),
        markLayerDirty: vi.fn(),
        compositeAndRender,
        updateThumbnail: vi.fn(),
        getVisibleCanvasRect: () => ({ left: 4, top: 5, right: 20, bottom: 21 }),
      })
    );

    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    act(() => {
      result.current.handleMovePointerDown(6, 7, { ctrlKey: false, pointerId: 31 });
      result.current.handleMovePointerMove(12, 10, { pointerId: 31 });
    });

    const previewCallMatched = compositeAndRender.mock.calls.some((call) => {
      const payload = call[0] as
        | {
            movePreview?: { layerId: string };
            clipRect?: { left: number; top: number; right: number; bottom: number };
          }
        | undefined;
      return payload?.movePreview?.layerId === 'layerA' && payload?.clipRect?.left === 4;
    });
    expect(previewCallMatched).toBe(true);

    rafSpy.mockRestore();
    cancelSpy.mockRestore();
  });

  it('expands selection preview bounds to avoid edge clipping during drag', async () => {
    const width = 32;
    const height = 32;
    const layerA = makeLayerCanvas('layerA', width, height);
    const renderer = {
      getLayer: vi.fn(() => layerA),
    } as unknown as LayerRenderer;

    useSelectionStore.setState({
      hasSelection: true,
      selectionMask: buildSelectionMask(width, height),
      selectionMaskPending: false,
      selectionPath: [
        [
          { x: 2, y: 2, type: 'polygonal' },
          { x: 10, y: 2, type: 'polygonal' },
          { x: 10, y: 10, type: 'polygonal' },
          { x: 2, y: 10, type: 'polygonal' },
          { x: 2, y: 2, type: 'polygonal' },
        ],
      ],
      bounds: { x: 2, y: 2, width: 8, height: 8 },
    });

    const compositeAndRender = vi.fn();

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
        saveStrokeToHistory: vi.fn(),
        markLayerDirty: vi.fn(),
        compositeAndRender,
        updateThumbnail: vi.fn(),
      })
    );

    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    act(() => {
      result.current.handleMovePointerDown(3, 3, { ctrlKey: false, pointerId: 77 });
      result.current.handleMovePointerMove(4, 4, { pointerId: 77 });
    });

    const previewCall = compositeAndRender.mock.calls.find((call) => {
      const payload = call[0] as
        | {
            movePreview?: { layerId: string };
            clipRect?: { left: number; top: number; right: number; bottom: number };
          }
        | undefined;
      return payload?.movePreview?.layerId === 'layerA';
    })?.[0] as
      | {
          movePreview?: { layerId: string };
          clipRect?: { left: number; top: number; right: number; bottom: number };
        }
      | undefined;

    expect(previewCall?.clipRect).toEqual({ left: 0, top: 0, right: 15, bottom: 15 });

    rafSpy.mockRestore();
    cancelSpy.mockRestore();
  });
});

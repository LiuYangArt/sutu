import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
vi.mock('@/utils/layerThumbnail', () => ({
  renderLayerThumbnail: vi.fn(() => null),
}));
import { useLayerOperations } from '../useLayerOperations';
import { useDocumentStore, type Layer } from '@/stores/document';
import { useHistoryStore } from '@/stores/history';
import type { SelectionSnapshot } from '@/stores/selection';
import type { LayerRenderer } from '@/utils/layerRenderer';

function createLayer(id: string, locked = false): Layer {
  return {
    id,
    name: id,
    type: 'raster',
    visible: true,
    locked,
    opacity: 100,
    blendMode: 'normal',
  };
}

function createBlankImageData(width: number, height: number): ImageData {
  return new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
}

function createSelectionSnapshot(mask: ImageData): SelectionSnapshot {
  return {
    hasSelection: true,
    selectionMask: mask,
    selectionMaskPending: false,
    selectionPath: [
      [
        { x: 0, y: 0, type: 'polygonal' },
        { x: mask.width, y: 0, type: 'polygonal' },
        { x: mask.width, y: mask.height, type: 'polygonal' },
        { x: 0, y: mask.height, type: 'polygonal' },
      ],
    ],
    bounds: { x: 0, y: 0, width: mask.width, height: mask.height },
  };
}

describe('useLayerOperations.applySelectionAutoFillToActiveLayer', () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
    useDocumentStore.setState({
      width: 2,
      height: 1,
      dpi: 72,
      backgroundFillColor: '#ffffff',
      pendingHistoryLayerAdds: [],
      filePath: null,
      fileFormat: null,
      isDirty: false,
      layers: [],
      activeLayerId: null,
      selectedLayerIds: [],
      layerSelectionAnchorId: null,
    });

    vi.spyOn(HTMLCanvasElement.prototype as any, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement
    ) {
      return {
        fillStyle: '#000000',
        globalCompositeOperation: 'source-over',
        putImageData: vi.fn(),
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        clearRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
    } as any);
  });

  it('writes stroke history with selection snapshots when auto fill succeeds', async () => {
    const layer = createLayer('layer_auto_fill');
    useDocumentStore.setState({
      layers: [layer],
      activeLayerId: layer.id,
      selectedLayerIds: [layer.id],
      layerSelectionAnchorId: layer.id,
    });

    const beforeImage = createBlankImageData(2, 1);
    const layerCtx = {
      drawImage: vi.fn(),
      fillRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const renderer = {
      getLayerImageData: vi.fn(() => beforeImage),
      getLayer: vi.fn(() => ({ id: layer.id, ctx: layerCtx })),
    } as unknown as LayerRenderer;

    const mask = new ImageData(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]), 2, 1);
    const selectionBefore: SelectionSnapshot = {
      hasSelection: false,
      selectionMask: null,
      selectionMaskPending: false,
      selectionPath: [],
      bounds: null,
    };
    const selectionAfter = createSelectionSnapshot(mask);

    const compositeAndRender = vi.fn();
    const markLayerDirty = vi.fn();
    const applyGpuSelectionFillToActiveLayer = vi.fn(async (_params: unknown) => true);

    const { result } = renderHook(() =>
      useLayerOperations({
        layerRendererRef: { current: renderer },
        activeLayerId: layer.id,
        layers: [layer],
        width: 2,
        height: 1,
        compositeAndRender,
        markLayerDirty,
        applyGpuSelectionFillToActiveLayer,
      })
    );

    let applied = false;
    await act(async () => {
      applied = await result.current.applySelectionAutoFillToActiveLayer({
        color: '#3366FF',
        selectionBefore,
        selectionAfter,
      });
    });

    expect(applied).toBe(true);
    const undoStack = useHistoryStore.getState().undoStack;
    const lastEntry = undoStack[undoStack.length - 1];
    expect(lastEntry?.type).toBe('stroke');
    if (!lastEntry || lastEntry.type !== 'stroke') return;
    expect(lastEntry.selectionBefore).toBe(selectionBefore);
    expect(lastEntry.selectionAfter).toBe(selectionAfter);
    expect(markLayerDirty).toHaveBeenCalledWith(layer.id);
    expect(compositeAndRender).toHaveBeenCalledTimes(1);
    expect(applyGpuSelectionFillToActiveLayer).toHaveBeenCalledTimes(1);
  });

  it('returns false and does not push stroke history when auto fill cannot apply', async () => {
    const layer = createLayer('layer_locked', true);
    useDocumentStore.setState({
      layers: [layer],
      activeLayerId: layer.id,
      selectedLayerIds: [layer.id],
      layerSelectionAnchorId: layer.id,
    });

    const renderer = {
      getLayerImageData: vi.fn(() => createBlankImageData(2, 1)),
      getLayer: vi.fn(() => ({ id: layer.id, ctx: { drawImage: vi.fn() } })),
    } as unknown as LayerRenderer;

    const mask = new ImageData(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]), 2, 1);
    const selectionAfter = createSelectionSnapshot(mask);
    const selectionBefore: SelectionSnapshot = {
      hasSelection: false,
      selectionMask: null,
      selectionMaskPending: false,
      selectionPath: [],
      bounds: null,
    };

    const { result } = renderHook(() =>
      useLayerOperations({
        layerRendererRef: { current: renderer },
        activeLayerId: layer.id,
        layers: [layer],
        width: 2,
        height: 1,
        compositeAndRender: vi.fn(),
        markLayerDirty: vi.fn(),
        applyGpuSelectionFillToActiveLayer: vi.fn(async (_params: unknown) => true),
      })
    );

    let applied = false;
    await act(async () => {
      applied = await result.current.applySelectionAutoFillToActiveLayer({
        color: '#3366FF',
        selectionBefore,
        selectionAfter,
      });
    });

    expect(applied).toBe(false);
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });

  it('returns false and does not push stroke history when gpu auto fill commit fails', async () => {
    const layer = createLayer('layer_gpu_fail');
    useDocumentStore.setState({
      layers: [layer],
      activeLayerId: layer.id,
      selectedLayerIds: [layer.id],
      layerSelectionAnchorId: layer.id,
    });

    const renderer = {
      getLayerImageData: vi.fn(() => createBlankImageData(2, 1)),
      getLayer: vi.fn(() => ({ id: layer.id, ctx: { drawImage: vi.fn() } })),
    } as unknown as LayerRenderer;

    const mask = new ImageData(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]), 2, 1);
    const selectionAfter = createSelectionSnapshot(mask);
    const selectionBefore: SelectionSnapshot = {
      hasSelection: false,
      selectionMask: null,
      selectionMaskPending: false,
      selectionPath: [],
      bounds: null,
    };

    const { result } = renderHook(() =>
      useLayerOperations({
        layerRendererRef: { current: renderer },
        activeLayerId: layer.id,
        layers: [layer],
        width: 2,
        height: 1,
        compositeAndRender: vi.fn(),
        markLayerDirty: vi.fn(),
        applyGpuSelectionFillToActiveLayer: vi.fn(async (_params: unknown) => false),
      })
    );

    let applied = true;
    await act(async () => {
      applied = await result.current.applySelectionAutoFillToActiveLayer({
        color: '#3366FF',
        selectionBefore,
        selectionAfter,
      });
    });

    expect(applied).toBe(false);
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });

  it('returns false and does not call gpu commit when selection snapshot is pending', async () => {
    const layer = createLayer('layer_pending_mask');
    useDocumentStore.setState({
      layers: [layer],
      activeLayerId: layer.id,
      selectedLayerIds: [layer.id],
      layerSelectionAnchorId: layer.id,
    });

    const renderer = {
      getLayerImageData: vi.fn(() => createBlankImageData(2, 1)),
      getLayer: vi.fn(() => ({ id: layer.id, ctx: { drawImage: vi.fn() } })),
    } as unknown as LayerRenderer;

    const mask = new ImageData(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]), 2, 1);
    const selectionAfter: SelectionSnapshot = {
      ...createSelectionSnapshot(mask),
      selectionMaskPending: true,
    };
    const selectionBefore: SelectionSnapshot = {
      hasSelection: false,
      selectionMask: null,
      selectionMaskPending: false,
      selectionPath: [],
      bounds: null,
    };
    const applyGpuSelectionFillToActiveLayer = vi.fn(async (_params: unknown) => true);

    const { result } = renderHook(() =>
      useLayerOperations({
        layerRendererRef: { current: renderer },
        activeLayerId: layer.id,
        layers: [layer],
        width: 2,
        height: 1,
        compositeAndRender: vi.fn(),
        markLayerDirty: vi.fn(),
        applyGpuSelectionFillToActiveLayer,
      })
    );

    let applied = true;
    await act(async () => {
      applied = await result.current.applySelectionAutoFillToActiveLayer({
        color: '#3366FF',
        selectionBefore,
        selectionAfter,
      });
    });

    expect(applied).toBe(false);
    expect(applyGpuSelectionFillToActiveLayer).not.toHaveBeenCalled();
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });
});

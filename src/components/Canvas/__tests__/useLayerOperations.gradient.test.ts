import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
vi.mock('@/utils/layerThumbnail', () => ({
  renderLayerThumbnail: vi.fn(() => null),
}));
import { useLayerOperations } from '../useLayerOperations';
import { useDocumentStore, type Layer } from '@/stores/document';
import { useHistoryStore } from '@/stores/history';
import { useSelectionStore } from '@/stores/selection';
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

describe('useLayerOperations.applyGradientToActiveLayer', () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
    useSelectionStore.getState().deselectAll();
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
  });

  it('fills active layer and pushes stroke history', async () => {
    const layer = createLayer('layer_a');
    useDocumentStore.setState({
      layers: [layer],
      activeLayerId: layer.id,
      selectedLayerIds: [layer.id],
      layerSelectionAnchorId: layer.id,
    });

    const beforeImage = createBlankImageData(2, 1);
    const setLayerImageData = vi.fn();

    const renderer = {
      getLayerImageData: vi.fn(() => beforeImage),
      setLayerImageData,
      getLayer: vi.fn(() => ({ id: layer.id })),
    } as unknown as LayerRenderer;

    const compositeAndRender = vi.fn();
    const markLayerDirty = vi.fn();

    const { result } = renderHook(() =>
      useLayerOperations({
        layerRendererRef: { current: renderer },
        activeLayerId: layer.id,
        layers: [layer],
        width: 2,
        height: 1,
        compositeAndRender,
        markLayerDirty,
      })
    );

    let applied = false;
    await act(async () => {
      applied = await result.current.applyGradientToActiveLayer({
        start: { x: 0, y: 0 },
        end: { x: 2, y: 0 },
        shape: 'linear',
        colorStops: [
          { id: 'c0', position: 0, midpoint: 0.5, source: 'fixed', color: '#000000' },
          { id: 'c1', position: 1, midpoint: 0.5, source: 'fixed', color: '#ffffff' },
        ],
        opacityStops: [
          { id: 'o0', position: 0, midpoint: 0.5, opacity: 1 },
          { id: 'o1', position: 1, midpoint: 0.5, opacity: 1 },
        ],
        blendMode: 'normal',
        opacity: 1,
        reverse: false,
        dither: false,
        transparency: true,
        foregroundColor: '#000000',
        backgroundColor: '#ffffff',
      });
    });

    expect(applied).toBe(true);
    expect(setLayerImageData).toHaveBeenCalledTimes(1);
    const undoStack = useHistoryStore.getState().undoStack;
    expect(undoStack[undoStack.length - 1]?.type).toBe('stroke');
    expect(compositeAndRender).toHaveBeenCalledTimes(1);
    expect(markLayerDirty).toHaveBeenCalledWith(layer.id);
  });

  it('respects selection mask and only writes selected pixels', async () => {
    const layer = createLayer('layer_mask');
    useDocumentStore.setState({
      layers: [layer],
      activeLayerId: layer.id,
      selectedLayerIds: [layer.id],
      layerSelectionAnchorId: layer.id,
    });

    const beforeData = new Uint8ClampedArray(8);
    beforeData[3] = 255;
    beforeData[7] = 255;
    const beforeImage = new ImageData(beforeData, 2, 1);

    const selectionMask = new ImageData(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]), 2, 1);
    useSelectionStore.setState({
      hasSelection: true,
      selectionMask,
      selectionMaskPending: false,
    });

    const setLayerImageData = vi.fn();
    const renderer = {
      getLayerImageData: vi.fn(() => beforeImage),
      setLayerImageData,
      getLayer: vi.fn(() => ({ id: layer.id })),
    } as unknown as LayerRenderer;

    const { result } = renderHook(() =>
      useLayerOperations({
        layerRendererRef: { current: renderer },
        activeLayerId: layer.id,
        layers: [layer],
        width: 2,
        height: 1,
        compositeAndRender: vi.fn(),
        markLayerDirty: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.applyGradientToActiveLayer({
        start: { x: 0, y: 0 },
        end: { x: 2, y: 0 },
        shape: 'linear',
        colorStops: [
          { id: 'c0', position: 0, midpoint: 0.5, source: 'fixed', color: '#ff0000' },
          { id: 'c1', position: 1, midpoint: 0.5, source: 'fixed', color: '#00ff00' },
        ],
        opacityStops: [
          { id: 'o0', position: 0, midpoint: 0.5, opacity: 1 },
          { id: 'o1', position: 1, midpoint: 0.5, opacity: 1 },
        ],
        blendMode: 'normal',
        opacity: 1,
        reverse: false,
        dither: false,
        transparency: true,
        foregroundColor: '#000000',
        backgroundColor: '#ffffff',
      });
    });

    const output = setLayerImageData.mock.calls[0]?.[1] as ImageData;
    expect(output).toBeDefined();
    expect(output.data[0]).toBeGreaterThan(0);
    expect(output.data[4]).toBe(0);
  });

  it('does not apply when layer is locked or selection mask is pending', async () => {
    const layer = createLayer('layer_locked', true);
    useDocumentStore.setState({
      layers: [layer],
      activeLayerId: layer.id,
      selectedLayerIds: [layer.id],
      layerSelectionAnchorId: layer.id,
    });

    const renderer = {
      getLayerImageData: vi.fn(() => createBlankImageData(2, 1)),
      setLayerImageData: vi.fn(),
      getLayer: vi.fn(() => ({ id: layer.id })),
    } as unknown as LayerRenderer;

    const { result, rerender } = renderHook(
      ({ active, allLayers }) =>
        useLayerOperations({
          layerRendererRef: { current: renderer },
          activeLayerId: active,
          layers: allLayers,
          width: 2,
          height: 1,
          compositeAndRender: vi.fn(),
          markLayerDirty: vi.fn(),
        }),
      { initialProps: { active: layer.id, allLayers: [layer] as Layer[] } }
    );

    let appliedLocked = false;
    await act(async () => {
      appliedLocked = await result.current.applyGradientToActiveLayer({
        start: { x: 0, y: 0 },
        end: { x: 2, y: 0 },
        shape: 'linear',
        colorStops: [
          { id: 'c0', position: 0, midpoint: 0.5, source: 'fixed', color: '#000000' },
          { id: 'c1', position: 1, midpoint: 0.5, source: 'fixed', color: '#ffffff' },
        ],
        opacityStops: [
          { id: 'o0', position: 0, midpoint: 0.5, opacity: 1 },
          { id: 'o1', position: 1, midpoint: 0.5, opacity: 1 },
        ],
        blendMode: 'normal',
        opacity: 1,
        reverse: false,
        dither: false,
        transparency: true,
        foregroundColor: '#000000',
        backgroundColor: '#ffffff',
      });
    });

    expect(appliedLocked).toBe(false);

    const unlocked = { ...layer, locked: false };
    useSelectionStore.setState({
      hasSelection: true,
      selectionMask: null,
      selectionMaskPending: true,
    });

    rerender({ active: unlocked.id, allLayers: [unlocked] });

    let appliedPending = false;
    await act(async () => {
      appliedPending = await result.current.applyGradientToActiveLayer({
        start: { x: 0, y: 0 },
        end: { x: 2, y: 0 },
        shape: 'linear',
        colorStops: [
          { id: 'c0', position: 0, midpoint: 0.5, source: 'fixed', color: '#000000' },
          { id: 'c1', position: 1, midpoint: 0.5, source: 'fixed', color: '#ffffff' },
        ],
        opacityStops: [
          { id: 'o0', position: 0, midpoint: 0.5, opacity: 1 },
          { id: 'o1', position: 1, midpoint: 0.5, opacity: 1 },
        ],
        blendMode: 'normal',
        opacity: 1,
        reverse: false,
        dither: false,
        transparency: true,
        foregroundColor: '#000000',
        backgroundColor: '#ffffff',
      });
    });

    expect(appliedPending).toBe(false);
    expect(renderer.setLayerImageData).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLayerOperations } from '../useLayerOperations';
import { useDocumentStore, type Layer } from '@/stores/document';
import { useHistoryStore } from '@/stores/history';
import type { LayerRenderer } from '@/utils/layerRenderer';

function createLayer(id: string, name: string): Layer {
  return {
    id,
    name,
    type: 'raster',
    visible: true,
    locked: false,
    opacity: 100,
    blendMode: 'normal',
  };
}

describe('useLayerOperations handleMergeSelectedLayers', () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
    useDocumentStore.setState({
      width: 64,
      height: 64,
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

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext' as never).mockImplementation((() => {
      return {
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        putImageData: vi.fn(),
        getImageData: vi.fn(() => new ImageData(64, 64)),
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
        fillRect: vi.fn(),
        globalCompositeOperation: 'source-over',
        globalAlpha: 1,
        lineCap: 'round',
        lineJoin: 'round',
      } as unknown as CanvasRenderingContext2D;
    }) as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
      () => 'data:image/png;base64,stub'
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges selected layers into top target and records mergeLayers history', () => {
    const layerBottom = createLayer('layer_bottom', 'Bottom');
    const layerTop = createLayer('layer_top', 'Top');

    useDocumentStore.setState({
      layers: [layerBottom, layerTop],
      activeLayerId: layerTop.id,
      selectedLayerIds: [layerBottom.id, layerTop.id],
      layerSelectionAnchorId: layerBottom.id,
    });

    const targetCtx = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const mockRenderer = {
      getLayerImageData: vi.fn((id: string) => {
        if (id === layerBottom.id) return new ImageData(64, 64);
        if (id === layerTop.id) return new ImageData(64, 64);
        return null;
      }),
      getLayer: vi.fn((id: string) => {
        if (id === layerTop.id) {
          return { id, canvas: document.createElement('canvas'), ctx: targetCtx };
        }
        if (id === layerBottom.id) {
          return { id, canvas: document.createElement('canvas'), ctx: targetCtx };
        }
        return null;
      }),
      updateLayer: vi.fn(),
      removeLayer: vi.fn(),
      setLayerOrder: vi.fn(),
      setLayerImageData: vi.fn(),
      createLayer: vi.fn(),
    } as unknown as LayerRenderer;

    const compositeAndRender = vi.fn();
    const markLayerDirty = vi.fn();
    const onBeforeCanvasMutation = vi.fn();

    const { result } = renderHook(() =>
      useLayerOperations({
        layerRendererRef: { current: mockRenderer },
        activeLayerId: layerTop.id,
        layers: [layerBottom, layerTop],
        width: 64,
        height: 64,
        compositeAndRender,
        markLayerDirty,
        onBeforeCanvasMutation,
      })
    );

    act(() => {
      result.current.handleMergeSelectedLayers([layerBottom.id, layerTop.id]);
    });

    expect(mockRenderer.removeLayer).toHaveBeenCalledWith(layerBottom.id);
    expect(mockRenderer.updateLayer).toHaveBeenCalledWith(layerTop.id, {
      blendMode: 'normal',
      opacity: 100,
    });
    expect(useDocumentStore.getState().layers.map((layer) => layer.id)).toEqual([layerTop.id]);
    expect(useDocumentStore.getState().selectedLayerIds).toEqual([layerTop.id]);
    const undoStack = useHistoryStore.getState().undoStack;
    expect(undoStack[undoStack.length - 1]?.type).toBe('mergeLayers');
    expect(compositeAndRender).toHaveBeenCalledTimes(1);
    expect(onBeforeCanvasMutation).toHaveBeenCalledTimes(1);
  });
});

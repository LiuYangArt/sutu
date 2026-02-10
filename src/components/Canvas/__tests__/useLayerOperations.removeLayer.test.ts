import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('useLayerOperations handleRemoveLayer', () => {
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
  });

  it('使用最新 document store 层数据删除图层，避免旧闭包 layers 导致 Del 失效', () => {
    const layerA = createLayer('layerA', 'Layer A');
    const layerB = createLayer('layerB', 'Layer B');

    useDocumentStore.setState({
      layers: [layerA, layerB],
      activeLayerId: layerB.id,
    });

    const getLayerImageDataSpy = vi.fn((id: string) =>
      id === layerB.id ? new ImageData(1, 1) : null
    );
    const removeLayerSpy = vi.fn();
    const mockRenderer = {
      getLayerImageData: getLayerImageDataSpy,
      removeLayer: removeLayerSpy,
    } as unknown as LayerRenderer;

    const compositeAndRender = vi.fn();
    const markLayerDirty = vi.fn();
    const onBeforeCanvasMutation = vi.fn();

    const { result } = renderHook(() =>
      useLayerOperations({
        layerRendererRef: { current: mockRenderer },
        activeLayerId: layerB.id,
        layers: [layerA],
        width: 64,
        height: 64,
        compositeAndRender,
        markLayerDirty,
        onBeforeCanvasMutation,
      })
    );

    act(() => {
      result.current.handleRemoveLayer(layerB.id);
    });

    expect(getLayerImageDataSpy).toHaveBeenCalledWith(layerB.id);
    expect(removeLayerSpy).toHaveBeenCalledWith(layerB.id);
    expect(useDocumentStore.getState().layers.map((l) => l.id)).toEqual([layerA.id]);
    const undoStack = useHistoryStore.getState().undoStack;
    expect(undoStack[undoStack.length - 1]?.type).toBe('removeLayer');
    expect(onBeforeCanvasMutation).toHaveBeenCalledTimes(1);
    expect(compositeAndRender).toHaveBeenCalledTimes(1);
    expect(markLayerDirty).toHaveBeenCalledWith(layerB.id);
  });

  it('handleRemoveLayers 批量删除写入单条 removeLayers 历史', () => {
    const layerA = createLayer('layerA', 'Layer A');
    const layerB = createLayer('layerB', 'Layer B');
    const layerC = createLayer('layerC', 'Layer C');

    useDocumentStore.setState({
      layers: [layerA, layerB, layerC],
      activeLayerId: layerC.id,
      selectedLayerIds: [layerB.id, layerC.id],
      layerSelectionAnchorId: layerB.id,
    });

    const getLayerImageDataSpy = vi.fn((id: string) =>
      ['layerB', 'layerC'].includes(id) ? new ImageData(1, 1) : new ImageData(1, 1)
    );
    const removeLayerSpy = vi.fn();
    const mockRenderer = {
      getLayerImageData: getLayerImageDataSpy,
      removeLayer: removeLayerSpy,
    } as unknown as LayerRenderer;

    const compositeAndRender = vi.fn();
    const markLayerDirty = vi.fn();
    const onBeforeCanvasMutation = vi.fn();

    const { result } = renderHook(() =>
      useLayerOperations({
        layerRendererRef: { current: mockRenderer },
        activeLayerId: layerC.id,
        layers: [layerA, layerB, layerC],
        width: 64,
        height: 64,
        compositeAndRender,
        markLayerDirty,
        onBeforeCanvasMutation,
      })
    );

    act(() => {
      result.current.handleRemoveLayers([layerB.id, layerC.id]);
    });

    expect(removeLayerSpy).toHaveBeenCalledWith(layerB.id);
    expect(removeLayerSpy).toHaveBeenCalledWith(layerC.id);
    expect(useDocumentStore.getState().layers.map((l) => l.id)).toEqual([layerA.id]);
    const undoStack = useHistoryStore.getState().undoStack;
    expect(undoStack[undoStack.length - 1]?.type).toBe('removeLayers');
    expect(onBeforeCanvasMutation).toHaveBeenCalledTimes(1);
    expect(compositeAndRender).toHaveBeenCalledTimes(1);
  });
});

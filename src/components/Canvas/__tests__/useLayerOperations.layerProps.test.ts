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

describe('useLayerOperations layer props history', () => {
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

  it('records opacity/blend changes and supports undo/redo', () => {
    const layerA = createLayer('layerA', 'Layer A');
    useDocumentStore.setState({
      layers: [layerA],
      activeLayerId: layerA.id,
      selectedLayerIds: [layerA.id],
      layerSelectionAnchorId: layerA.id,
    });

    const updateLayerSpy = vi.fn();
    const mockRenderer = {
      updateLayer: updateLayerSpy,
    } as unknown as LayerRenderer;

    const compositeAndRender = vi.fn();
    const markLayerDirty = vi.fn();
    const onBeforeCanvasMutation = vi.fn();

    const { result } = renderHook(() =>
      useLayerOperations({
        layerRendererRef: { current: mockRenderer },
        activeLayerId: layerA.id,
        layers: [layerA],
        width: 64,
        height: 64,
        compositeAndRender,
        markLayerDirty,
        onBeforeCanvasMutation,
      })
    );

    act(() => {
      result.current.handleSetLayerOpacity([layerA.id], 55);
      result.current.handleSetLayerBlendMode([layerA.id], 'multiply');
    });

    let layerState = useDocumentStore.getState().layers.find((layer) => layer.id === layerA.id);
    expect(layerState?.opacity).toBe(55);
    expect(layerState?.blendMode).toBe('multiply');

    const undoStack = useHistoryStore.getState().undoStack;
    const latestEntry = undoStack[undoStack.length - 1];
    expect(latestEntry?.type).toBe('layerProps');

    act(() => {
      result.current.handleUndo();
    });

    layerState = useDocumentStore.getState().layers.find((layer) => layer.id === layerA.id);
    expect(layerState?.blendMode).toBe('normal');

    act(() => {
      result.current.handleUndo();
    });

    layerState = useDocumentStore.getState().layers.find((layer) => layer.id === layerA.id);
    expect(layerState?.opacity).toBe(100);

    act(() => {
      result.current.handleRedo();
      result.current.handleRedo();
    });

    layerState = useDocumentStore.getState().layers.find((layer) => layer.id === layerA.id);
    expect(layerState?.opacity).toBe(55);
    expect(layerState?.blendMode).toBe('multiply');
    expect(updateLayerSpy).toHaveBeenCalled();
    expect(compositeAndRender).toHaveBeenCalled();
    expect(markLayerDirty).toHaveBeenCalled();
    expect(onBeforeCanvasMutation).toHaveBeenCalled();
  });

  it('keeps hover preview out of history and commits click result correctly', () => {
    const layerA = createLayer('layerA', 'Layer A');
    useDocumentStore.setState({
      layers: [layerA],
      activeLayerId: layerA.id,
      selectedLayerIds: [layerA.id],
      layerSelectionAnchorId: layerA.id,
    });

    const updateLayerSpy = vi.fn();
    const mockRenderer = {
      updateLayer: updateLayerSpy,
    } as unknown as LayerRenderer;

    const compositeAndRender = vi.fn();
    const markLayerDirty = vi.fn();
    const onBeforeCanvasMutation = vi.fn();

    const { result } = renderHook(() =>
      useLayerOperations({
        layerRendererRef: { current: mockRenderer },
        activeLayerId: layerA.id,
        layers: [layerA],
        width: 64,
        height: 64,
        compositeAndRender,
        markLayerDirty,
        onBeforeCanvasMutation,
      })
    );

    act(() => {
      result.current.handlePreviewLayerBlendMode([layerA.id], 'multiply');
    });

    let layerState = useDocumentStore.getState().layers.find((layer) => layer.id === layerA.id);
    expect(layerState?.blendMode).toBe('multiply');
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
    expect(onBeforeCanvasMutation).not.toHaveBeenCalled();

    let restoredCount = 0;
    act(() => {
      restoredCount = result.current.handleClearLayerBlendModePreview();
    });
    layerState = useDocumentStore.getState().layers.find((layer) => layer.id === layerA.id);
    expect(restoredCount).toBe(1);
    expect(layerState?.blendMode).toBe('normal');
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);

    act(() => {
      result.current.handlePreviewLayerBlendMode([layerA.id], 'screen');
      result.current.handleSetLayerBlendMode([layerA.id], 'screen');
    });

    layerState = useDocumentStore.getState().layers.find((layer) => layer.id === layerA.id);
    expect(layerState?.blendMode).toBe('screen');
    const undoStack = useHistoryStore.getState().undoStack;
    const latestEntry = undoStack[undoStack.length - 1];
    expect(latestEntry?.type).toBe('layerProps');
    expect(onBeforeCanvasMutation).toHaveBeenCalledTimes(1);
    expect(updateLayerSpy).toHaveBeenCalled();
    expect(compositeAndRender).toHaveBeenCalled();
    expect(markLayerDirty).toHaveBeenCalled();
  });
});

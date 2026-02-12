import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
vi.mock('@/utils/layerThumbnail', () => ({
  renderLayerThumbnail: vi.fn(() => null),
}));
import { useLayerOperations } from '../useLayerOperations';
import { useDocumentStore, type Layer } from '@/stores/document';
import { useHistoryStore } from '@/stores/history';
import { useSelectionStore } from '@/stores/selection';
import { useToolStore } from '@/stores/tool';
import type { LayerRenderer } from '@/utils/layerRenderer';

function resetDocumentState(): void {
  useDocumentStore.setState({
    width: 1,
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
}

function createLayer(id: string): Layer {
  return {
    id,
    name: 'Background',
    type: 'raster',
    visible: true,
    locked: false,
    opacity: 100,
    blendMode: 'normal',
    isBackground: true,
  };
}

describe('useLayerOperations.handleClearLayer', () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
    useSelectionStore.getState().deselectAll();
    resetDocumentState();
  });

  it('uses current tool background color when clearing background layer', async () => {
    const layer = createLayer('layer_bg');
    useDocumentStore.setState({
      layers: [layer],
      activeLayerId: layer.id,
      selectedLayerIds: [layer.id],
      layerSelectionAnchorId: layer.id,
    });
    useToolStore.setState({ backgroundColor: '#ff8800' });

    const clearLayer = vi.fn();
    const renderer = {
      clearLayer,
      getLayerImageData: vi.fn(() => new ImageData(1, 1)),
      getLayer: vi.fn(() => ({ canvas: document.createElement('canvas') })),
    } as unknown as LayerRenderer;

    const compositeAndRender = vi.fn();
    const markLayerDirty = vi.fn();

    const { result } = renderHook(() =>
      useLayerOperations({
        layerRendererRef: { current: renderer },
        activeLayerId: layer.id,
        layers: [layer],
        width: 1,
        height: 1,
        compositeAndRender,
        markLayerDirty,
      })
    );

    await act(async () => {
      result.current.handleClearLayer();
    });

    await waitFor(() => {
      expect(clearLayer).toHaveBeenCalledTimes(1);
    });

    expect(clearLayer).toHaveBeenCalledWith(layer.id, '#ff8800');
    expect(compositeAndRender).toHaveBeenCalledTimes(1);
    expect(markLayerDirty).toHaveBeenCalledWith(layer.id);
    const undoStack = useHistoryStore.getState().undoStack;
    expect(undoStack[undoStack.length - 1]?.type).toBe('stroke');
  });
});

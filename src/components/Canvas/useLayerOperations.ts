import { useCallback, useRef, type RefObject } from 'react';
import { useSelectionStore } from '@/stores/selection';
import { useDocumentStore, type Layer, type ResizeCanvasOptions } from '@/stores/document';
import {
  createHistoryEntryId,
  type PushStrokeParams,
  type StrokeSnapshotMode,
  useHistoryStore,
} from '@/stores/history';
import { LayerRenderer } from '@/utils/layerRenderer';
import { renderLayerThumbnail } from '@/utils/layerThumbnail';

interface UseLayerOperationsParams {
  layerRendererRef: RefObject<LayerRenderer | null>;
  activeLayerId: string | null;
  layers: Layer[];
  width: number;
  height: number;
  compositeAndRender: () => void;
  markLayerDirty: () => void;
  syncGpuLayerForHistory?: (layerId: string) => Promise<boolean>;
  gpuHistoryEnabled?: boolean;
  beginGpuStrokeHistory?: (
    layerId: string
  ) => { entryId: string; snapshotMode: StrokeSnapshotMode } | null;
  applyGpuStrokeHistory?: (
    entryId: string,
    direction: 'undo' | 'redo',
    layerId: string
  ) => Promise<boolean>;
}

type PendingStrokeHistory =
  | {
      layerId: string;
      entryId: string;
      snapshotMode: 'cpu';
      beforeImage: ImageData;
    }
  | {
      layerId: string;
      entryId: string;
      snapshotMode: 'gpu';
    };

function toPushStrokeParams(pending: PendingStrokeHistory): PushStrokeParams {
  if (pending.snapshotMode === 'gpu') {
    return {
      layerId: pending.layerId,
      entryId: pending.entryId,
      snapshotMode: 'gpu',
    };
  }
  return {
    layerId: pending.layerId,
    entryId: pending.entryId,
    snapshotMode: 'cpu',
    beforeImage: pending.beforeImage,
  };
}

/**
 * Helper to fill a layer using a selection mask (anti-aliased)
 */
function fillWithMask(
  ctx: CanvasRenderingContext2D,
  mask: ImageData,
  color: string,
  width: number,
  height: number
): void {
  // Create temp canvas for the mask
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) return;

  // Put the mask data
  maskCtx.putImageData(mask, 0, 0);

  // Composite fill color IN the mask
  // Source (color) IN Destination (mask) -> Result keeps color where mask is opaque
  maskCtx.globalCompositeOperation = 'source-in';
  maskCtx.fillStyle = color;
  maskCtx.fillRect(0, 0, width, height);

  // Draw the result onto the active layer
  ctx.drawImage(maskCanvas, 0, 0);
}

function snapshotLayers(
  renderer: LayerRenderer,
  layers: Array<{ id: string }>
): Array<{ layerId: string; imageData: ImageData }> | null {
  const snapshots: Array<{ layerId: string; imageData: ImageData }> = [];
  for (const layer of layers) {
    const imageData = renderer.getLayerImageData(layer.id);
    if (!imageData) return null;
    snapshots.push({ layerId: layer.id, imageData });
  }
  return snapshots;
}

export function useLayerOperations({
  layerRendererRef,
  activeLayerId,
  layers,
  width,
  height,
  compositeAndRender,
  markLayerDirty,
  syncGpuLayerForHistory,
  gpuHistoryEnabled = false,
  beginGpuStrokeHistory,
  applyGpuStrokeHistory,
}: UseLayerOperationsParams) {
  const updateLayerThumbnail = useDocumentStore((s) => s.updateLayerThumbnail);
  const { pushStroke, pushRemoveLayer, pushResizeCanvas, undo, redo } = useHistoryStore();

  // Store beforeImage when stroke starts
  const beforeImageRef = useRef<PendingStrokeHistory | null>(null);

  const pushCpuStrokeHistory = useCallback(
    (layerId: string, beforeImage: ImageData, entryId: string = createHistoryEntryId()) => {
      pushStroke({
        layerId,
        entryId,
        snapshotMode: 'cpu',
        beforeImage,
      });
    },
    [pushStroke]
  );

  // Update layer thumbnail
  const updateThumbnailWithSize = useCallback(
    (layerId: string, docWidth: number, docHeight: number) => {
      if (!layerRendererRef.current) return;
      const layer = layerRendererRef.current.getLayer(layerId);
      if (!layer) return;

      const thumb = renderLayerThumbnail(layer.canvas, docWidth, docHeight);
      if (thumb) updateLayerThumbnail(layerId, thumb);
    },
    [updateLayerThumbnail, layerRendererRef]
  );

  const updateThumbnail = useCallback(
    (layerId: string) => updateThumbnailWithSize(layerId, width, height),
    [width, height, updateThumbnailWithSize]
  );

  // 起笔前保存 beforeImage。
  // no-readback 下必须先同步待刷新的 GPU tiles，否则一次撤销会跨越多笔。
  const captureBeforeImage = useCallback(
    async (preferGpuHistory = true): Promise<void> => {
      const renderer = layerRendererRef.current;
      if (!renderer || !activeLayerId) return;

      const gpuEntry =
        preferGpuHistory && gpuHistoryEnabled && beginGpuStrokeHistory
          ? beginGpuStrokeHistory(activeLayerId)
          : null;
      if (gpuEntry?.snapshotMode === 'gpu') {
        beforeImageRef.current = {
          layerId: activeLayerId,
          entryId: gpuEntry.entryId,
          snapshotMode: 'gpu',
        };
        return;
      }

      await syncGpuLayerForHistory?.(activeLayerId);

      const imageData = renderer.getLayerImageData(activeLayerId);
      if (imageData) {
        beforeImageRef.current = {
          layerId: activeLayerId,
          entryId: gpuEntry?.entryId ?? createHistoryEntryId(),
          snapshotMode: 'cpu',
          beforeImage: imageData,
        };
      }
    },
    [
      activeLayerId,
      beginGpuStrokeHistory,
      gpuHistoryEnabled,
      layerRendererRef,
      syncGpuLayerForHistory,
    ]
  );

  // Push stroke to history using beforeImage
  const saveStrokeToHistory = useCallback(() => {
    const pending = beforeImageRef.current;
    if (!pending) return;

    pushStroke(toPushStrokeParams(pending));
    beforeImageRef.current = null;
  }, [pushStroke]);

  // Resize canvas with history support
  const handleResizeCanvas = useCallback(
    (options: ResizeCanvasOptions) => {
      const renderer = layerRendererRef.current;
      if (!renderer) return;

      const docState = useDocumentStore.getState();
      const beforeWidth = docState.width;
      const beforeHeight = docState.height;

      if (options.width === beforeWidth && options.height === beforeHeight) return;

      const beforeLayers = snapshotLayers(renderer, docState.layers);
      if (!beforeLayers) return;

      pushResizeCanvas(beforeWidth, beforeHeight, beforeLayers);
      useSelectionStore.getState().deselectAll();

      renderer.resizeWithOptions(options);
      useDocumentStore.setState({ width: options.width, height: options.height });

      compositeAndRender();
      markLayerDirty();

      for (const layer of docState.layers) {
        updateThumbnailWithSize(layer.id, options.width, options.height);
      }
    },
    [
      compositeAndRender,
      markLayerDirty,
      layerRendererRef,
      pushResizeCanvas,
      updateThumbnailWithSize,
    ]
  );

  // Fill active layer with a color (Alt+Backspace shortcut)
  const fillActiveLayer = useCallback(
    (color: string) => {
      if (!activeLayerId) return;
      void (async () => {
        await syncGpuLayerForHistory?.(activeLayerId);

        const renderer = layerRendererRef.current;
        if (!renderer) return;

        // Check if layer is locked
        const layerState = layers.find((l) => l.id === activeLayerId);
        if (!layerState || layerState.locked) return;

        const layer = renderer.getLayer(activeLayerId);
        if (!layer) return;

        // Capture before image for undo
        const beforeImage = renderer.getLayerImageData(activeLayerId);
        if (!beforeImage) return;

        // Check for active selection
        const { hasSelection, selectionMask } = useSelectionStore.getState();

        if (hasSelection && selectionMask) {
          fillWithMask(layer.ctx, selectionMask, color, width, height);
        } else if (!hasSelection) {
          // Only fill if NO selection. If hasSelection is true but no mask (shouldn't happen), do nothing safely
          // Fill the entire layer
          layer.ctx.fillStyle = color;
          layer.ctx.fillRect(0, 0, width, height);
        }

        // Save to history
        pushCpuStrokeHistory(activeLayerId, beforeImage);

        // Update thumbnail and re-render
        markLayerDirty();
        updateThumbnail(activeLayerId);
        compositeAndRender();
      })();
    },
    [
      activeLayerId,
      layers,
      width,
      height,
      pushCpuStrokeHistory,
      markLayerDirty,
      updateThumbnail,
      compositeAndRender,
      syncGpuLayerForHistory,
      layerRendererRef,
    ]
  );

  // Clear selection content from active layer
  const handleClearSelection = useCallback(() => {
    if (!activeLayerId) return;
    void (async () => {
      await syncGpuLayerForHistory?.(activeLayerId);

      const renderer = layerRendererRef.current;
      if (!renderer) return;

      // Check if layer is locked
      const layerState = layers.find((l) => l.id === activeLayerId);
      if (!layerState || layerState.locked) return;

      const layer = renderer.getLayer(activeLayerId);
      if (!layer) return;

      // Check for active selection
      const { hasSelection, selectionMask } = useSelectionStore.getState();
      if (!hasSelection || !selectionMask) return;

      // Capture before image for undo
      const beforeImage = renderer.getLayerImageData(activeLayerId);
      if (!beforeImage) return;

      // Create temp canvas for the mask
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = width;
      maskCanvas.height = height;
      const maskCtx = maskCanvas.getContext('2d');
      if (!maskCtx) return;

      // Put the mask data
      maskCtx.putImageData(selectionMask, 0, 0);

      // Composite: Destination-Out to erase where mask is defined
      const ctx = layer.ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(maskCanvas, 0, 0);
      ctx.restore();

      // Save to history
      pushCpuStrokeHistory(activeLayerId, beforeImage);

      // Update thumbnail and re-render
      markLayerDirty();
      updateThumbnail(activeLayerId);
      compositeAndRender();
    })();
  }, [
    activeLayerId,
    layers,
    width,
    height,
    pushCpuStrokeHistory,
    markLayerDirty,
    updateThumbnail,
    compositeAndRender,
    syncGpuLayerForHistory,
    layerRendererRef,
  ]);

  // Handle undo for all operation types
  const handleUndo = useCallback(() => {
    void (async () => {
      let entry = undo();
      while (
        entry &&
        entry.type === 'stroke' &&
        !layers.some((l) => l.id === (entry as { layerId: string }).layerId)
      ) {
        entry = undo();
      }
      if (!entry) return;

      if (entry.type === 'selection') {
        entry.after = useSelectionStore.getState().createSnapshot();
        useSelectionStore.getState().applySnapshot(entry.before);
        return;
      }

      const renderer = layerRendererRef.current;
      if (!renderer) return;

      switch (entry.type) {
        case 'stroke': {
          const gpuApplied =
            entry.snapshotMode === 'gpu' &&
            (await applyGpuStrokeHistory?.(entry.entryId, 'undo', entry.layerId));
          if (gpuApplied) {
            compositeAndRender();
            markLayerDirty();
            updateThumbnail(entry.layerId);
            break;
          }

          await syncGpuLayerForHistory?.(entry.layerId);
          // Save current state (afterImage) for redo before restoring
          const currentImageData = renderer.getLayerImageData(entry.layerId);
          if (currentImageData) {
            entry.afterImage = currentImageData;
          }
          if (!entry.beforeImage) {
            console.warn('[History] Missing CPU beforeImage for undo fallback', {
              layerId: entry.layerId,
              entryId: entry.entryId,
              snapshotMode: entry.snapshotMode,
            });
            break;
          }
          renderer.setLayerImageData(entry.layerId, entry.beforeImage);
          compositeAndRender();
          markLayerDirty();
          updateThumbnail(entry.layerId);
          break;
        }
        case 'resizeCanvas': {
          const docState = useDocumentStore.getState();
          const afterWidth = docState.width;
          const afterHeight = docState.height;

          const afterLayers = snapshotLayers(renderer, docState.layers);
          if (!afterLayers) return;

          entry.after = { width: afterWidth, height: afterHeight, layers: afterLayers };

          renderer.resize(entry.beforeWidth, entry.beforeHeight);
          for (const layer of entry.beforeLayers) {
            renderer.setLayerImageData(layer.layerId, layer.imageData);
          }

          useDocumentStore.setState({ width: entry.beforeWidth, height: entry.beforeHeight });
          useSelectionStore.getState().deselectAll();

          compositeAndRender();
          markLayerDirty();
          for (const layer of docState.layers) {
            updateThumbnailWithSize(layer.id, entry.beforeWidth, entry.beforeHeight);
          }
          break;
        }
        case 'addLayer': {
          // Undo add = remove the layer
          const { removeLayer } = useDocumentStore.getState();
          renderer.removeLayer(entry.layerId);
          removeLayer(entry.layerId);
          compositeAndRender();
          markLayerDirty();
          break;
        }
        case 'removeLayer': {
          // Undo remove = restore the layer
          // Insert layer back at original index
          useDocumentStore.setState((state) => {
            const newLayers = [...state.layers];
            newLayers.splice(entry.layerIndex, 0, entry.layerMeta);
            return { layers: newLayers, activeLayerId: entry.layerId };
          });
          // Recreate in renderer and restore content
          renderer.createLayer(entry.layerId, {
            visible: entry.layerMeta.visible,
            opacity: entry.layerMeta.opacity,
            blendMode: entry.layerMeta.blendMode,
            isBackground: entry.layerMeta.isBackground,
          });
          renderer.setLayerImageData(entry.layerId, entry.imageData);
          renderer.setLayerOrder(useDocumentStore.getState().layers.map((l) => l.id));
          compositeAndRender();
          markLayerDirty();
          updateThumbnail(entry.layerId);
          break;
        }
      }
    })();
  }, [
    undo,
    applyGpuStrokeHistory,
    layers,
    compositeAndRender,
    markLayerDirty,
    syncGpuLayerForHistory,
    updateThumbnail,
    updateThumbnailWithSize,
    layerRendererRef,
  ]);

  // Handle redo for all operation types
  const handleRedo = useCallback(() => {
    void (async () => {
      const entry = redo();
      if (!entry) return;

      if (entry.type === 'selection') {
        if (entry.after) {
          useSelectionStore.getState().applySnapshot(entry.after);
        }
        return;
      }

      const renderer = layerRendererRef.current;
      if (!renderer) return;

      switch (entry.type) {
        case 'stroke': {
          const gpuApplied =
            entry.snapshotMode === 'gpu' &&
            (await applyGpuStrokeHistory?.(entry.entryId, 'redo', entry.layerId));
          if (gpuApplied) {
            compositeAndRender();
            markLayerDirty();
            updateThumbnail(entry.layerId);
            break;
          }

          // Restore afterImage (saved during undo)
          if (entry.afterImage) {
            renderer.setLayerImageData(entry.layerId, entry.afterImage);
            compositeAndRender();
            markLayerDirty();
            updateThumbnail(entry.layerId);
          }
          break;
        }
        case 'resizeCanvas': {
          if (!entry.after) return;

          renderer.resize(entry.after.width, entry.after.height);
          for (const layer of entry.after.layers) {
            renderer.setLayerImageData(layer.layerId, layer.imageData);
          }

          useDocumentStore.setState({ width: entry.after.width, height: entry.after.height });
          useSelectionStore.getState().deselectAll();

          compositeAndRender();
          markLayerDirty();

          const docState = useDocumentStore.getState();
          for (const layer of docState.layers) {
            updateThumbnailWithSize(layer.id, entry.after.width, entry.after.height);
          }
          break;
        }
        case 'addLayer': {
          // Redo add = add the layer back
          useDocumentStore.setState((state) => {
            const newLayers = [...state.layers];
            newLayers.splice(entry.layerIndex, 0, entry.layerMeta);
            return { layers: newLayers, activeLayerId: entry.layerId };
          });
          renderer.createLayer(entry.layerId, {
            visible: entry.layerMeta.visible,
            opacity: entry.layerMeta.opacity,
            blendMode: entry.layerMeta.blendMode,
            isBackground: entry.layerMeta.isBackground,
          });
          renderer.setLayerOrder(useDocumentStore.getState().layers.map((l) => l.id));
          compositeAndRender();
          markLayerDirty();
          updateThumbnail(entry.layerId);
          break;
        }
        case 'removeLayer': {
          // Redo remove = remove the layer again
          const { removeLayer } = useDocumentStore.getState();
          renderer.removeLayer(entry.layerId);
          removeLayer(entry.layerId);
          compositeAndRender();
          markLayerDirty();
          break;
        }
      }
    })();
  }, [
    redo,
    applyGpuStrokeHistory,
    compositeAndRender,
    markLayerDirty,
    updateThumbnail,
    updateThumbnailWithSize,
    layerRendererRef,
  ]);

  // Clear current layer content
  const handleClearLayer = useCallback(() => {
    if (!activeLayerId) return;
    void (async () => {
      const renderer = layerRendererRef.current;
      if (!renderer) return;

      // Capture state before clearing for undo
      await captureBeforeImage(false);

      // Clear the layer
      renderer.clearLayer(activeLayerId, useDocumentStore.getState().backgroundFillColor);
      compositeAndRender();

      // Push to history
      saveStrokeToHistory();
      markLayerDirty();
      updateThumbnail(activeLayerId);
    })();
  }, [
    activeLayerId,
    captureBeforeImage,
    saveStrokeToHistory,
    compositeAndRender,
    markLayerDirty,
    updateThumbnail,
    layerRendererRef,
  ]);

  // Duplicate layer content from source to target
  const handleDuplicateLayer = useCallback(
    (fromId: string, toId: string) => {
      const renderer = layerRendererRef.current;
      if (!renderer) return;

      const sourceLayer = renderer.getLayer(fromId);
      const targetLayer = renderer.getLayer(toId);

      if (!sourceLayer || !targetLayer) return;

      // Copy the source layer content to target layer
      targetLayer.ctx.drawImage(sourceLayer.canvas, 0, 0);
      compositeAndRender();
      markLayerDirty();
      updateThumbnail(toId);
    },
    [compositeAndRender, markLayerDirty, updateThumbnail, layerRendererRef]
  );

  // Remove layer with history support
  const handleRemoveLayer = useCallback(
    (layerId: string) => {
      const renderer = layerRendererRef.current;
      if (!renderer) return;

      // Get layer info before removing
      const layerState = layers.find((l) => l.id === layerId);
      const layerIndex = layers.findIndex((l) => l.id === layerId);
      const imageData = renderer.getLayerImageData(layerId);

      if (!layerState || layerIndex === -1 || !imageData) return;

      // Save to history
      pushRemoveLayer(layerId, layerState, layerIndex, imageData);

      // Remove from renderer and document
      renderer.removeLayer(layerId);
      const { removeLayer } = useDocumentStore.getState();
      removeLayer(layerId);

      compositeAndRender();
      markLayerDirty();
    },
    [layers, pushRemoveLayer, compositeAndRender, markLayerDirty, layerRendererRef]
  );

  return {
    updateThumbnail,
    captureBeforeImage,
    saveStrokeToHistory,
    fillActiveLayer,
    handleClearSelection,
    handleUndo,
    handleRedo,
    handleClearLayer,
    handleDuplicateLayer,
    handleRemoveLayer,
    handleResizeCanvas,
  };
}

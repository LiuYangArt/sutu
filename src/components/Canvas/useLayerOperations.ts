import { useCallback, useRef, type RefObject } from 'react';
import { useSelectionStore } from '@/stores/selection';
import type { SelectionPoint, SelectionSnapshot } from '@/stores/selection';
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
  compositeAndRender: (options?: { forceCpu?: boolean }) => void;
  markLayerDirty: (layerIds?: string | string[]) => void;
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
  onBeforeCanvasMutation?: () => void;
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

interface SaveStrokeHistoryOptions {
  selectionBefore?: SelectionSnapshot;
  selectionAfter?: SelectionSnapshot;
}

function createCanvasContext2D(
  width: number,
  height: number
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}

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
  const maskLayer = createCanvasContext2D(width, height);
  if (!maskLayer) return;

  // Put the mask data
  maskLayer.ctx.putImageData(mask, 0, 0);

  // Composite fill color IN the mask
  // Source (color) IN Destination (mask) -> Result keeps color where mask is opaque
  maskLayer.ctx.globalCompositeOperation = 'source-in';
  maskLayer.ctx.fillStyle = color;
  maskLayer.ctx.fillRect(0, 0, width, height);

  // Draw the result onto the active layer
  ctx.drawImage(maskLayer.canvas, 0, 0);
}

function pathToMask(paths: SelectionPoint[][], width: number, height: number): ImageData | null {
  if (paths.length === 0) return null;

  const maskLayer = createCanvasContext2D(width, height);
  if (!maskLayer) return null;
  const { ctx } = maskLayer;

  ctx.fillStyle = 'white';
  ctx.beginPath();

  let hasContour = false;
  for (const contour of paths) {
    if (contour.length < 3) continue;
    const first = contour[0];
    if (!first) continue;

    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < contour.length; i += 1) {
      const point = contour[i];
      if (!point) continue;
      ctx.lineTo(point.x, point.y);
    }
    ctx.closePath();
    hasContour = true;
  }

  if (!hasContour) return null;

  ctx.fill('evenodd');
  return ctx.getImageData(0, 0, width, height);
}

function getDuplicateSelectionMask(
  selectionOnly: boolean | undefined,
  width: number,
  height: number
): ImageData | null {
  if (!selectionOnly) return null;

  const selectionState = useSelectionStore.getState();
  if (!selectionState.hasSelection) return null;
  return selectionState.selectionMask ?? pathToMask(selectionState.selectionPath, width, height);
}

function applyLayerDuplicateContent(
  sourceCanvas: HTMLCanvasElement,
  targetCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
  selectionMask: ImageData | null
): void {
  targetCtx.clearRect(0, 0, width, height);

  if (!selectionMask) {
    targetCtx.drawImage(sourceCanvas, 0, 0);
    return;
  }

  const tempLayer = createCanvasContext2D(width, height);
  if (!tempLayer) return;

  tempLayer.ctx.drawImage(sourceCanvas, 0, 0);

  const maskLayer = createCanvasContext2D(width, height);
  if (!maskLayer) return;
  maskLayer.ctx.putImageData(selectionMask, 0, 0);

  tempLayer.ctx.save();
  tempLayer.ctx.globalCompositeOperation = 'destination-in';
  tempLayer.ctx.drawImage(maskLayer.canvas, 0, 0);
  tempLayer.ctx.restore();

  targetCtx.drawImage(tempLayer.canvas, 0, 0);
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
  onBeforeCanvasMutation,
}: UseLayerOperationsParams) {
  const updateLayerThumbnail = useDocumentStore((s) => s.updateLayerThumbnail);
  const setDocumentDirty = useDocumentStore((s) => s.setDirty);
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
  const saveStrokeToHistory = useCallback(
    (options?: SaveStrokeHistoryOptions) => {
      const pending = beforeImageRef.current;
      if (!pending) return;

      pushStroke({
        ...toPushStrokeParams(pending),
        selectionBefore: options?.selectionBefore,
        selectionAfter: options?.selectionAfter,
      });
      beforeImageRef.current = null;
      setDocumentDirty(true);
    },
    [pushStroke, setDocumentDirty]
  );

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

      onBeforeCanvasMutation?.();
      pushResizeCanvas(beforeWidth, beforeHeight, beforeLayers);
      useSelectionStore.getState().deselectAll();

      renderer.resizeWithOptions(options);
      useDocumentStore.setState({ width: options.width, height: options.height });
      setDocumentDirty(true);

      compositeAndRender();
      markLayerDirty(docState.layers.map((layer) => layer.id));

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
      onBeforeCanvasMutation,
      setDocumentDirty,
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

        onBeforeCanvasMutation?.();

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
        setDocumentDirty(true);

        // Update thumbnail and re-render
        markLayerDirty(activeLayerId);
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
      onBeforeCanvasMutation,
      setDocumentDirty,
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

      onBeforeCanvasMutation?.();

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
      setDocumentDirty(true);

      // Update thumbnail and re-render
      markLayerDirty(activeLayerId);
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
    onBeforeCanvasMutation,
    setDocumentDirty,
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

      onBeforeCanvasMutation?.();

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
            if (entry.selectionBefore) {
              entry.selectionAfter = useSelectionStore.getState().createSnapshot();
              useSelectionStore.getState().applySnapshot(entry.selectionBefore);
            }
            compositeAndRender();
            markLayerDirty(entry.layerId);
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
          if (entry.selectionBefore) {
            entry.selectionAfter = useSelectionStore.getState().createSnapshot();
            useSelectionStore.getState().applySnapshot(entry.selectionBefore);
          }
          compositeAndRender();
          markLayerDirty(entry.layerId);
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
          markLayerDirty(docState.layers.map((layer) => layer.id));
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
          markLayerDirty(entry.layerId);
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
          markLayerDirty(entry.layerId);
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
    onBeforeCanvasMutation,
  ]);

  // Handle redo for all operation types
  const handleRedo = useCallback(() => {
    void (async () => {
      const entry = redo();
      if (!entry) return;

      onBeforeCanvasMutation?.();

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
            if (entry.selectionAfter) {
              useSelectionStore.getState().applySnapshot(entry.selectionAfter);
            }
            compositeAndRender();
            markLayerDirty(entry.layerId);
            updateThumbnail(entry.layerId);
            break;
          }

          // Restore afterImage (saved during undo)
          if (entry.afterImage) {
            renderer.setLayerImageData(entry.layerId, entry.afterImage);
          }
          if (entry.selectionAfter) {
            useSelectionStore.getState().applySnapshot(entry.selectionAfter);
          }
          compositeAndRender();
          markLayerDirty(entry.layerId);
          updateThumbnail(entry.layerId);
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

          const docState = useDocumentStore.getState();
          compositeAndRender();
          markLayerDirty(docState.layers.map((layer) => layer.id));
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
          markLayerDirty(entry.layerId);
          updateThumbnail(entry.layerId);
          break;
        }
        case 'removeLayer': {
          // Redo remove = remove the layer again
          const { removeLayer } = useDocumentStore.getState();
          renderer.removeLayer(entry.layerId);
          removeLayer(entry.layerId);
          compositeAndRender();
          markLayerDirty(entry.layerId);
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
    onBeforeCanvasMutation,
  ]);

  // Clear current layer content
  const handleClearLayer = useCallback(() => {
    if (!activeLayerId) return;
    void (async () => {
      const renderer = layerRendererRef.current;
      if (!renderer) return;

      onBeforeCanvasMutation?.();

      // Capture state before clearing for undo
      await captureBeforeImage(false);

      // Clear the layer
      renderer.clearLayer(activeLayerId, useDocumentStore.getState().backgroundFillColor);
      setDocumentDirty(true);
      compositeAndRender();

      // Push to history
      saveStrokeToHistory();
      markLayerDirty(activeLayerId);
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
    onBeforeCanvasMutation,
    setDocumentDirty,
  ]);

  // Duplicate layer content from source to target
  const handleDuplicateLayer = useCallback(
    (fromId: string, toId: string, options?: { selectionOnly?: boolean }) => {
      onBeforeCanvasMutation?.();

      const tryCopy = (): boolean => {
        const renderer = layerRendererRef.current;
        if (!renderer) return false;

        const sourceLayer = renderer.getLayer(fromId);
        const targetLayer = renderer.getLayer(toId);
        if (!sourceLayer || !targetLayer) return false;

        const selectionMask = getDuplicateSelectionMask(options?.selectionOnly, width, height);

        applyLayerDuplicateContent(
          sourceLayer.canvas,
          targetLayer.ctx,
          width,
          height,
          selectionMask
        );
        setDocumentDirty(true);
        compositeAndRender();
        markLayerDirty(toId);
        updateThumbnail(toId);
        return true;
      };

      if (tryCopy()) return;

      // New layer may be created on next render pass; retry once.
      window.requestAnimationFrame(() => {
        void tryCopy();
      });
    },
    [
      compositeAndRender,
      height,
      markLayerDirty,
      updateThumbnail,
      width,
      layerRendererRef,
      onBeforeCanvasMutation,
      setDocumentDirty,
    ]
  );

  const handleDuplicateActiveLayer = useCallback(() => {
    if (!activeLayerId) return;
    const { duplicateLayer } = useDocumentStore.getState();
    const newLayerId = duplicateLayer(activeLayerId);
    if (!newLayerId) return;

    const { hasSelection } = useSelectionStore.getState();
    handleDuplicateLayer(activeLayerId, newLayerId, { selectionOnly: hasSelection });
  }, [activeLayerId, handleDuplicateLayer]);

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

      onBeforeCanvasMutation?.();

      // Save to history
      pushRemoveLayer(layerId, layerState, layerIndex, imageData);

      // Remove from renderer and document
      renderer.removeLayer(layerId);
      const { removeLayer } = useDocumentStore.getState();
      removeLayer(layerId);

      compositeAndRender();
      markLayerDirty(layerId);
    },
    [
      layers,
      pushRemoveLayer,
      compositeAndRender,
      markLayerDirty,
      layerRendererRef,
      onBeforeCanvasMutation,
    ]
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
    handleDuplicateActiveLayer,
    handleRemoveLayer,
    handleResizeCanvas,
  };
}

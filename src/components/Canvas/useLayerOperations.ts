import { useCallback, useRef, type RefObject } from 'react';
import { useSelectionStore } from '@/stores/selection';
import { useDocumentStore, type Layer, type ResizeCanvasOptions } from '@/stores/document';
import { useHistoryStore } from '@/stores/history';
import { LayerRenderer } from '@/utils/layerRenderer';

interface UseLayerOperationsParams {
  layerRendererRef: RefObject<LayerRenderer | null>;
  activeLayerId: string | null;
  layers: Layer[];
  width: number;
  height: number;
  compositeAndRender: () => void;
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

export function useLayerOperations({
  layerRendererRef,
  activeLayerId,
  layers,
  width,
  height,
  compositeAndRender,
}: UseLayerOperationsParams) {
  const updateLayerThumbnail = useDocumentStore((s) => s.updateLayerThumbnail);
  const { pushStroke, pushRemoveLayer, pushResizeCanvas, undo, redo } = useHistoryStore();

  // Store beforeImage when stroke starts
  const beforeImageRef = useRef<{ layerId: string; imageData: ImageData } | null>(null);

  // Update layer thumbnail
  const updateThumbnailWithSize = useCallback(
    (layerId: string, docWidth: number, docHeight: number) => {
      if (!layerRendererRef.current) return;
      const layer = layerRendererRef.current.getLayer(layerId);
      if (!layer) return;

      const thumbCanvas = document.createElement('canvas');
      const aspect = docWidth / docHeight;
      const thumbWidth = 64;
      const thumbHeight = thumbWidth / aspect;

      thumbCanvas.width = thumbWidth;
      thumbCanvas.height = thumbHeight;

      const ctx = thumbCanvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, thumbWidth, thumbHeight);
      ctx.drawImage(layer.canvas, 0, 0, thumbWidth, thumbHeight);

      updateLayerThumbnail(layerId, thumbCanvas.toDataURL());
    },
    [updateLayerThumbnail, layerRendererRef]
  );

  const updateThumbnail = useCallback(
    (layerId: string) => updateThumbnailWithSize(layerId, width, height),
    [width, height, updateThumbnailWithSize]
  );

  // Save beforeImage at stroke start
  const captureBeforeImage = useCallback(() => {
    const renderer = layerRendererRef.current;
    if (!renderer || !activeLayerId) return;

    const imageData = renderer.getLayerImageData(activeLayerId);
    if (imageData) {
      beforeImageRef.current = { layerId: activeLayerId, imageData };
    }
  }, [activeLayerId, layerRendererRef]);

  // Push stroke to history using beforeImage
  const saveStrokeToHistory = useCallback(() => {
    if (!beforeImageRef.current) return;

    const { layerId, imageData } = beforeImageRef.current;
    pushStroke(layerId, imageData);
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

      const beforeLayers: Array<{ layerId: string; imageData: ImageData }> = [];
      for (const layer of docState.layers) {
        const imageData = renderer.getLayerImageData(layer.id);
        if (!imageData) return;
        beforeLayers.push({ layerId: layer.id, imageData });
      }

      pushResizeCanvas(beforeWidth, beforeHeight, beforeLayers);
      useSelectionStore.getState().deselectAll();

      renderer.resizeWithOptions(options);
      useDocumentStore.setState({ width: options.width, height: options.height });

      compositeAndRender();

      for (const layer of docState.layers) {
        updateThumbnailWithSize(layer.id, options.width, options.height);
      }
    },
    [compositeAndRender, layerRendererRef, pushResizeCanvas, updateThumbnailWithSize]
  );

  // Fill active layer with a color (Alt+Backspace shortcut)
  const fillActiveLayer = useCallback(
    (color: string) => {
      const renderer = layerRendererRef.current;
      if (!renderer || !activeLayerId) return;

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
      pushStroke(activeLayerId, beforeImage);

      // Update thumbnail and re-render
      updateLayerThumbnail(activeLayerId, layer.canvas.toDataURL('image/png', 0.5));
      compositeAndRender();
    },
    [
      activeLayerId,
      layers,
      width,
      height,
      pushStroke,
      updateLayerThumbnail,
      compositeAndRender,
      layerRendererRef,
    ]
  );

  // Clear selection content from active layer
  const handleClearSelection = useCallback(() => {
    const renderer = layerRendererRef.current;
    if (!renderer || !activeLayerId) return;

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
    pushStroke(activeLayerId, beforeImage);

    // Update thumbnail and re-render
    updateLayerThumbnail(activeLayerId, layer.canvas.toDataURL('image/png', 0.5));
    compositeAndRender();
  }, [
    activeLayerId,
    layers,
    width,
    height,
    pushStroke,
    updateLayerThumbnail,
    compositeAndRender,
    layerRendererRef,
  ]);

  // Handle undo for all operation types
  const handleUndo = useCallback(() => {
    const entry = undo();
    if (!entry) return;

    const renderer = layerRendererRef.current;
    if (!renderer) return;

    switch (entry.type) {
      case 'stroke': {
        // Check if layer still exists, skip if not
        const layerExists = layers.some((l) => l.id === entry.layerId);
        if (!layerExists) {
          // Layer was deleted, skip this undo and try next
          handleUndo();
          return;
        }

        // Save current state (afterImage) for redo before restoring
        const currentImageData = renderer.getLayerImageData(entry.layerId);
        if (currentImageData) {
          entry.afterImage = currentImageData;
        }
        renderer.setLayerImageData(entry.layerId, entry.beforeImage);
        compositeAndRender();
        updateThumbnail(entry.layerId);
        break;
      }
      case 'resizeCanvas': {
        const docState = useDocumentStore.getState();
        const afterWidth = docState.width;
        const afterHeight = docState.height;

        const afterLayers: Array<{ layerId: string; imageData: ImageData }> = [];
        for (const layer of docState.layers) {
          const imageData = renderer.getLayerImageData(layer.id);
          if (!imageData) return;
          afterLayers.push({ layerId: layer.id, imageData });
        }

        entry.after = { width: afterWidth, height: afterHeight, layers: afterLayers };

        renderer.resize(entry.beforeWidth, entry.beforeHeight);
        for (const layer of entry.beforeLayers) {
          renderer.setLayerImageData(layer.layerId, layer.imageData);
        }

        useDocumentStore.setState({ width: entry.beforeWidth, height: entry.beforeHeight });
        useSelectionStore.getState().deselectAll();

        compositeAndRender();
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
        updateThumbnail(entry.layerId);
        break;
      }
    }
  }, [
    undo,
    layers,
    compositeAndRender,
    updateThumbnail,
    updateThumbnailWithSize,
    layerRendererRef,
  ]);

  // Handle redo for all operation types
  const handleRedo = useCallback(() => {
    const entry = redo();
    if (!entry) return;

    const renderer = layerRendererRef.current;
    if (!renderer) return;

    switch (entry.type) {
      case 'stroke': {
        // Restore afterImage (saved during undo)
        if (entry.afterImage) {
          renderer.setLayerImageData(entry.layerId, entry.afterImage);
          compositeAndRender();
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
        updateThumbnail(entry.layerId);
        break;
      }
      case 'removeLayer': {
        // Redo remove = remove the layer again
        const { removeLayer } = useDocumentStore.getState();
        renderer.removeLayer(entry.layerId);
        removeLayer(entry.layerId);
        compositeAndRender();
        break;
      }
    }
  }, [redo, compositeAndRender, updateThumbnail, updateThumbnailWithSize, layerRendererRef]);

  // Clear current layer content
  const handleClearLayer = useCallback(() => {
    const renderer = layerRendererRef.current;
    if (!renderer || !activeLayerId) return;

    // Capture state before clearing for undo
    captureBeforeImage();

    // Clear the layer
    renderer.clearLayer(activeLayerId);
    compositeAndRender();

    // Push to history
    saveStrokeToHistory();
    updateThumbnail(activeLayerId);
  }, [
    activeLayerId,
    captureBeforeImage,
    saveStrokeToHistory,
    compositeAndRender,
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
      updateThumbnail(toId);
    },
    [compositeAndRender, updateThumbnail, layerRendererRef]
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
    },
    [layers, pushRemoveLayer, compositeAndRender, layerRendererRef]
  );

  return {
    updateThumbnail,
    updateThumbnailWithSize,
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

import { useRef, useEffect, useCallback, useState } from 'react';
import { useDocumentStore } from '@/stores/document';
import { useToolStore, applyPressureCurve, ToolType } from '@/stores/tool';
import { useViewportStore } from '@/stores/viewport';
import { useHistoryStore } from '@/stores/history';
import { useTabletStore, drainPointBuffer, clearPointBuffer } from '@/stores/tablet';
import { StrokeBuffer, Point } from '@/utils/interpolation';
import { LayerRenderer } from '@/utils/layerRenderer';
import './Canvas.css';

import { useCursor } from './useCursor';
import { useBrushRenderer, BrushRenderConfig } from './useBrushRenderer';
import { getEffectiveInputData } from './inputUtils';
import { useRawPointerInput, supportsPointerRawUpdate } from './useRawPointerInput';
import { LatencyProfiler, FPSCounter, LagometerMonitor } from '@/benchmark';

declare global {
  interface Window {
    __strokeDiagnostics?: {
      onStrokeStart: () => void;
      onStateChange: (state: string) => void;
      onPointBuffered: () => void;
      onPointDropped: () => void;
      onStrokeEnd: () => void;
    };
    __canvasFillLayer?: (color: string) => void;
  }
}

export function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDrawingRef = useRef(false);

  // Benchmark refs
  const pointIndexRef = useRef(0);
  const latencyProfilerRef = useRef<LatencyProfiler>(new LatencyProfiler());
  const fpsCounterRef = useRef<FPSCounter>(new FPSCounter());
  const lagometerRef = useRef<LagometerMonitor>(new LagometerMonitor());
  const lastRenderedPosRef = useRef<{ x: number; y: number } | null>(null);

  // Performance optimization: Input queue for batch processing
  type QueuedPoint = { x: number; y: number; pressure: number; pointIndex: number };
  const inputQueueRef = useRef<QueuedPoint[]>([]);
  const MAX_POINTS_PER_FRAME = 2000;
  const needsRenderRef = useRef(false);

  // Expose for debug panel (including getQueueDepth for performance monitoring)
  useEffect(() => {
    window.__benchmark = {
      latencyProfiler: latencyProfilerRef.current,
      fpsCounter: fpsCounterRef.current,
      lagometer: lagometerRef.current,
      // Queue depth monitoring for performance diagnosis
      getQueueDepth: () => inputQueueRef.current.length,
      // Q1: pointerrawupdate support status
      supportsPointerRawUpdate,
      // Reset function for benchmark runner
      resetForScenario: () => {
        pointIndexRef.current = 0;
        lastRenderedPosRef.current = null;
        inputQueueRef.current = [];
      },
    };
  }, []);

  // Phase 2.7: State machine for brush strokes
  // Solves race conditions where input events arrive before initialization completes
  type StrokeState = 'idle' | 'starting' | 'active' | 'finishing';

  // State machine refs
  const strokeStateRef = useRef<StrokeState>('idle');
  const pendingPointsRef = useRef<
    Array<{ x: number; y: number; pressure: number; pointIndex: number }>
  >([]);
  const pendingEndRef = useRef(false); // Flag: PointerUp arrived during 'starting' phase

  const isZoomingRef = useRef(false);
  const zoomStartRef = useRef<{ x: number; y: number; startScale: number } | null>(null);
  const strokeBufferRef = useRef<StrokeBuffer>(new StrokeBuffer(2));
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const layerRendererRef = useRef<LayerRenderer | null>(null);
  const historyInitializedRef = useRef(false);

  const [spacePressed, setSpacePressed] = useState(false);
  const [altPressed, setAltPressed] = useState(false);

  const brushCursorRef = useRef<HTMLDivElement>(null);
  const previousToolRef = useRef<string | null>(null);

  const { width, height, layers, activeLayerId, initDocument, updateLayerThumbnail } =
    useDocumentStore((s) => ({
      width: s.width,
      height: s.height,
      layers: s.layers,
      activeLayerId: s.activeLayerId,
      initDocument: s.initDocument,
      updateLayerThumbnail: s.updateLayerThumbnail,
    }));

  const {
    currentTool,
    brushSize,
    eraserSize,
    brushColor,
    brushOpacity,
    brushFlow,
    brushHardness,
    brushMaskType,
    brushSpacing,
    brushRoundness,
    brushAngle,
    pressureCurve,
    pressureSizeEnabled,
    pressureFlowEnabled,
    pressureOpacityEnabled,
    setCurrentSize,
    setBrushColor,
    setTool,
    showCrosshair,
    renderMode,
    brushTexture,
  } = useToolStore((s) => ({
    currentTool: s.currentTool,
    brushSize: s.brushSize,
    eraserSize: s.eraserSize,
    brushColor: s.brushColor,
    brushOpacity: s.brushOpacity,
    brushFlow: s.brushFlow,
    brushHardness: s.brushHardness,
    brushMaskType: s.brushMaskType,
    brushSpacing: s.brushSpacing,
    brushRoundness: s.brushRoundness,
    brushAngle: s.brushAngle,
    pressureCurve: s.pressureCurve,
    pressureSizeEnabled: s.pressureSizeEnabled,
    pressureFlowEnabled: s.pressureFlowEnabled,
    pressureOpacityEnabled: s.pressureOpacityEnabled,
    setCurrentSize: s.setCurrentSize,
    setBrushColor: s.setBrushColor,
    setTool: s.setTool,
    showCrosshair: s.showCrosshair,
    renderMode: s.renderMode,
    brushTexture: s.brushTexture,
  }));

  // Get current tool size (brush or eraser)
  const currentSize = currentTool === 'eraser' ? eraserSize : brushSize;

  const { scale, offsetX, offsetY, isPanning, zoomIn, zoomOut, pan, setIsPanning, setScale } =
    useViewportStore();

  const { cursorStyle, showDomCursor } = useCursor({
    currentTool,
    currentSize,
    scale,
    showCrosshair,
    spacePressed,
    isPanning,
    containerRef,
    brushCursorRef,
  });

  const { pushStroke, pushAddLayer, pushRemoveLayer, undo, redo } = useHistoryStore();

  // Store beforeImage when stroke starts
  const beforeImageRef = useRef<{ layerId: string; imageData: ImageData } | null>(null);

  // Initialize brush renderer for Flow/Opacity three-level pipeline
  const {
    beginStroke: beginBrushStroke,
    processPoint: processBrushPoint,
    endStroke: endBrushStroke,
    getPreviewCanvas,
    getPreviewOpacity,
    isStrokeActive,
    flushPending,
    backend: _activeBackend,
    gpuAvailable: _gpuAvailable,
  } = useBrushRenderer({
    width,
    height,
    renderMode,
    benchmarkProfiler: latencyProfilerRef.current,
  });

  // Tablet store: We use getState() directly in event handlers for real-time data
  // No need to subscribe to state changes here since we sync-read in handlers

  // Q1 Optimization: Use pointerrawupdate for lower-latency input (1-3ms improvement)
  const { usingRawInput } = useRawPointerInput({
    containerRef,
    canvasRef,
    scale,
    isDrawingRef,
    currentTool,
    strokeStateRef,
    pendingPointsRef,
    inputQueueRef,
    pointIndexRef,
    latencyProfiler: latencyProfilerRef.current,
    onPointBuffered: () => window.__strokeDiagnostics?.onPointBuffered(),
  });

  // Get the active layer's context for drawing
  const getActiveLayerCtx = useCallback(() => {
    if (!layerRendererRef.current || !activeLayerId) return null;
    const layer = layerRendererRef.current.getLayer(activeLayerId);
    return layer?.ctx ?? null;
  }, [activeLayerId]);

  // Composite all layers and render to display canvas
  const compositeAndRender = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const renderer = layerRendererRef.current;

    if (!canvas || !ctx || !renderer) return;

    // Composite all layers
    const compositeCanvas = renderer.composite();

    // Clear and draw composite to display canvas
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(compositeCanvas, 0, 0);
  }, [width, height]);

  // Save beforeImage at stroke start
  const captureBeforeImage = useCallback(() => {
    const renderer = layerRendererRef.current;
    if (!renderer || !activeLayerId) return;

    const imageData = renderer.getLayerImageData(activeLayerId);
    if (imageData) {
      beforeImageRef.current = { layerId: activeLayerId, imageData };
    }
  }, [activeLayerId]);

  // Push stroke to history using beforeImage
  const saveStrokeToHistory = useCallback(() => {
    if (!beforeImageRef.current) return;

    const { layerId, imageData } = beforeImageRef.current;
    pushStroke(layerId, imageData);
    beforeImageRef.current = null;
  }, [pushStroke]);

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

      // Fill the layer
      layer.ctx.fillStyle = color;
      layer.ctx.fillRect(0, 0, width, height);

      // Save to history
      pushStroke(activeLayerId, beforeImage);

      // Update thumbnail and re-render
      updateLayerThumbnail(activeLayerId, layer.canvas.toDataURL('image/png', 0.5));
      compositeAndRender();
    },
    [activeLayerId, layers, width, height, pushStroke, updateLayerThumbnail, compositeAndRender]
  );

  // Expose fillActiveLayer to window for keyboard shortcut
  useEffect(() => {
    window.__canvasFillLayer = fillActiveLayer;
    return () => {
      delete window.__canvasFillLayer;
    };
  }, [fillActiveLayer]);

  // Update layer thumbnail
  const updateThumbnail = useCallback(
    (layerId: string) => {
      if (!layerRendererRef.current) return;
      const layer = layerRendererRef.current.getLayer(layerId);
      if (!layer) return;

      const thumbCanvas = document.createElement('canvas');
      const aspect = width / height;
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
    [width, height, updateLayerThumbnail]
  );

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
  }, [undo, layers, compositeAndRender, updateThumbnail]);

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
  }, [redo, compositeAndRender, updateThumbnail]);

  // Pick color from canvas at given coordinates
  const pickColorAt = useCallback(
    (canvasX: number, canvasY: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;

      const x = Math.floor(canvasX);
      const y = Math.floor(canvasY);

      if (x < 0 || x >= width || y < 0 || y >= height) return;

      const pixel = ctx.getImageData(x, y, 1, 1).data;
      const r = pixel[0] ?? 0;
      const g = pixel[1] ?? 0;
      const b = pixel[2] ?? 0;

      const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      setBrushColor(hex);
    },
    [width, height, setBrushColor]
  );

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
  }, [activeLayerId, captureBeforeImage, saveStrokeToHistory, compositeAndRender, updateThumbnail]);

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
    [compositeAndRender, updateThumbnail]
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
    [layers, pushRemoveLayer, compositeAndRender]
  );

  // Expose undo/redo/clearLayer/duplicateLayer/removeLayer handlers globally for toolbar
  useEffect(() => {
    const win = window as Window & {
      __canvasUndo?: () => void;
      __canvasRedo?: () => void;
      __canvasClearLayer?: () => void;
      __canvasDuplicateLayer?: (from: string, to: string) => void;
      __canvasRemoveLayer?: (id: string) => void;
    };
    win.__canvasUndo = handleUndo;
    win.__canvasRedo = handleRedo;
    win.__canvasClearLayer = handleClearLayer;
    win.__canvasDuplicateLayer = handleDuplicateLayer;
    win.__canvasRemoveLayer = handleRemoveLayer;

    return () => {
      delete win.__canvasUndo;
      delete win.__canvasRedo;
      delete win.__canvasClearLayer;
      delete win.__canvasDuplicateLayer;
      delete win.__canvasRemoveLayer;
    };
  }, [handleUndo, handleRedo, handleClearLayer, handleDuplicateLayer, handleRemoveLayer]);

  // Initialize document and layer renderer
  useEffect(() => {
    // Initialize document if no layers exist
    if (layers.length === 0) {
      initDocument({ width, height, dpi: 72 });
    }
  }, [layers.length, initDocument, width, height]);

  // Initialize layer renderer and sync with document layers
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Create or update layer renderer
    if (!layerRendererRef.current) {
      layerRendererRef.current = new LayerRenderer(width, height);
    } else {
      layerRendererRef.current.resize(width, height);
    }

    const renderer = layerRendererRef.current;

    // Sync layers from document store
    const existingIds = new Set(renderer.getLayerIds());
    const documentIds = new Set(layers.map((l) => l.id));

    // Remove layers that no longer exist
    for (const id of existingIds) {
      if (!documentIds.has(id)) {
        renderer.removeLayer(id);
      }
    }

    // Add or update layers
    for (const layer of layers) {
      if (!existingIds.has(layer.id)) {
        // Create new layer
        renderer.createLayer(layer.id, {
          visible: layer.visible,
          opacity: layer.opacity,
          blendMode: layer.blendMode,
          fillColor: layer.isBackground ? '#ffffff' : undefined,
          isBackground: layer.isBackground,
        });
        // Generate initial thumbnail for new layers
        updateThumbnail(layer.id);

        // Save initial state to history for new layers
        // Use pushAddLayer to record layer creation for undo
        const layerIndex = layers.findIndex((l) => l.id === layer.id);
        pushAddLayer(layer.id, layer, layerIndex);
      } else {
        // Update existing layer properties
        renderer.updateLayer(layer.id, {
          visible: layer.visible,
          opacity: layer.opacity,
          blendMode: layer.blendMode,
          isBackground: layer.isBackground,
        });
      }
    }

    // Update layer order
    renderer.setLayerOrder(layers.map((l) => l.id));

    // Initial composite render
    compositeAndRender();

    // Mark history as initialized after first layer is added
    if (activeLayerId && !historyInitializedRef.current) {
      historyInitializedRef.current = true;
    }
  }, [layers, width, height, activeLayerId, compositeAndRender, pushAddLayer, updateThumbnail]);

  // Re-composite when layer visibility/opacity changes
  useEffect(() => {
    compositeAndRender();
  }, [layers, compositeAndRender]);

  // 鼠标滚轮缩放
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const centerX = e.clientX - rect.left;
      const centerY = e.clientY - rect.top;

      if (e.deltaY < 0) {
        zoomIn(centerX, centerY);
      } else {
        zoomOut(centerX, centerY);
      }
    },
    [zoomIn, zoomOut]
  );

  // 使用 passive: false 注册 wheel 事件，以便 preventDefault() 正常工作
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [handleWheel]);

  // Check if active layer is a background layer
  const isActiveLayerBackground = useCallback(() => {
    if (!layerRendererRef.current || !activeLayerId) return false;
    const layer = layerRendererRef.current.getLayer(activeLayerId);
    return layer?.isBackground ?? false;
  }, [activeLayerId]);

  // Build brush render config for the three-level pipeline
  const getBrushConfig = useCallback((): BrushRenderConfig => {
    return {
      size: currentSize,
      flow: brushFlow,
      opacity: brushOpacity,
      hardness: brushHardness,
      maskType: brushMaskType,
      spacing: brushSpacing,
      roundness: brushRoundness,
      angle: brushAngle,
      color: brushColor,
      pressureSizeEnabled,
      pressureFlowEnabled,
      pressureOpacityEnabled,
      pressureCurve,
      texture: brushTexture,
    };
  }, [
    currentSize,
    brushFlow,
    brushOpacity,
    brushHardness,
    brushMaskType,
    brushSpacing,
    brushRoundness,
    brushAngle,
    brushColor,
    pressureSizeEnabled,
    pressureFlowEnabled,
    pressureOpacityEnabled,
    pressureCurve,
    brushTexture,
  ]);

  // Composite with stroke buffer preview overlay at correct layer position
  const compositeAndRenderWithPreview = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const renderer = layerRendererRef.current;

    if (!canvas || !ctx || !renderer) return;

    // Build preview config if stroke is active
    const preview =
      isStrokeActive() && activeLayerId
        ? (() => {
            const previewCanvas = getPreviewCanvas();
            return previewCanvas
              ? { activeLayerId, canvas: previewCanvas, opacity: getPreviewOpacity() }
              : undefined;
          })()
        : undefined;

    // Composite with optional preview
    const compositeCanvas = renderer.composite(preview);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(compositeCanvas, 0, 0);
  }, [width, height, isStrokeActive, getPreviewCanvas, getPreviewOpacity, activeLayerId]);

  // Process a single point through the brush renderer WITHOUT triggering composite
  // Used by batch processing loop in RAF
  const processSinglePoint = useCallback(
    (x: number, y: number, pressure: number, pointIndex?: number) => {
      const config = getBrushConfig();
      lagometerRef.current.setBrushRadius(config.size / 2);

      processBrushPoint(x, y, pressure, config, pointIndex);

      // Track last rendered position for Visual Lag measurement
      lastRenderedPosRef.current = { x, y };
    },
    [getBrushConfig, processBrushPoint]
  );

  // Process a single point AND trigger composite (legacy behavior, used during state machine replay)
  const processBrushPointWithConfig = useCallback(
    (x: number, y: number, pressure: number, pointIndex?: number) => {
      processSinglePoint(x, y, pressure, pointIndex);
      // Mark that we need to render after processing
      needsRenderRef.current = true;
    },
    [processSinglePoint]
  );

  // RAF loop: Batch process queued points and composite once per frame
  useEffect(() => {
    latencyProfilerRef.current.enable();
    const fpsCounter = fpsCounterRef.current;
    fpsCounter.start();

    let id: number;
    const loop = () => {
      fpsCounter.tick();

      // Batch process all queued points (with soft limit)
      const queue = inputQueueRef.current;
      if (queue.length > 0) {
        // Visual Lag: measure distance from last queued point (newest input)
        // to last rendered point (before this batch)
        const lastQueuedPoint = queue[queue.length - 1]!;
        const renderedPosBefore = lastRenderedPosRef.current;
        if (renderedPosBefore) {
          lagometerRef.current.measure(renderedPosBefore, lastQueuedPoint);
        }

        const count = Math.min(queue.length, MAX_POINTS_PER_FRAME);

        // Drain and process points
        for (let i = 0; i < count; i++) {
          const p = queue[i]!;
          processSinglePoint(p.x, p.y, p.pressure, p.pointIndex);
        }

        // Clear processed points from queue
        inputQueueRef.current = count === queue.length ? [] : queue.slice(count);

        flushPending();

        needsRenderRef.current = true;
      }

      // Composite once per frame if needed
      if (needsRenderRef.current) {
        compositeAndRenderWithPreview();
        needsRenderRef.current = false;
      }

      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);

    return () => {
      fpsCounter.stop();
      cancelAnimationFrame(id);
    };
  }, [compositeAndRenderWithPreview, processSinglePoint, flushPending]);

  // 绘制插值后的点序列 (used for eraser, legacy fallback)
  const drawPoints = useCallback(
    (points: Point[]) => {
      const ctx = getActiveLayerCtx();
      if (!ctx || points.length < 2) return;

      const isEraser = currentTool === 'eraser';
      const isBackground = isActiveLayerBackground();

      for (let i = 1; i < points.length; i++) {
        const from = points[i - 1];
        const to = points[i];

        if (!from || !to) continue;

        // 应用压感曲线后计算线条粗细
        const adjustedPressure = applyPressureCurve(to.pressure, pressureCurve);
        const size = currentSize * adjustedPressure;
        const opacity = brushOpacity * adjustedPressure;

        ctx.globalAlpha = opacity;
        ctx.lineWidth = Math.max(1, size);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (isEraser) {
          if (isBackground) {
            // Background layer: draw white instead of erasing to transparency
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = '#ffffff';
          } else {
            // Normal layer: erase to transparency
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
          }
        } else {
          // Brush: normal drawing
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = brushColor;
        }

        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }

      // Reset composite operation
      ctx.globalCompositeOperation = 'source-over';

      // Update composite display
      compositeAndRender();
    },
    [
      currentSize,
      brushColor,
      brushOpacity,
      pressureCurve,
      currentTool,
      getActiveLayerCtx,
      compositeAndRender,
      isActiveLayerBackground,
    ]
  );

  // Internal stroke finishing logic (called after state machine validation)
  // Renamed to finalizeStroke for clarity
  const finalizeStroke = useCallback(async () => {
    // 清理 WinTab 缓冲区
    clearPointBuffer();

    // For brush tool, composite stroke buffer to layer with opacity ceiling
    if (currentTool === 'brush') {
      // Process any remaining points in queue before finalizing
      const remainingQueue = inputQueueRef.current;
      if (remainingQueue.length > 0) {
        for (const p of remainingQueue) {
          processSinglePoint(p.x, p.y, p.pressure, p.pointIndex);
        }
        inputQueueRef.current = [];
      }

      const layerCtx = getActiveLayerCtx();
      if (layerCtx) {
        await endBrushStroke(layerCtx);
      }
      compositeAndRender();
    } else {
      // For eraser, use the legacy stroke buffer
      const remainingPoints = strokeBufferRef.current.finish();
      if (remainingPoints.length > 0) {
        drawPoints(remainingPoints);
      }
    }

    // Save stroke to history (uses beforeImage captured at stroke start)
    saveStrokeToHistory();
    if (activeLayerId) {
      updateThumbnail(activeLayerId);
    }

    isDrawingRef.current = false;
    strokeStateRef.current = 'idle';
    lastRenderedPosRef.current = null;
    window.__strokeDiagnostics?.onStrokeEnd();
  }, [
    currentTool,
    getActiveLayerCtx,
    endBrushStroke,
    compositeAndRender,
    drawPoints,
    saveStrokeToHistory,
    activeLayerId,
    updateThumbnail,
    processSinglePoint,
  ]);

  // Finish the current stroke properly (used by PointerUp and Alt key)
  // Phase 2.7: Uses state machine to handle starting/active/finishing states
  const finishCurrentStroke = useCallback(async () => {
    if (!isDrawingRef.current) return;

    const state = strokeStateRef.current;

    // Case 1: Still in 'starting' phase - mark pendingEnd, let PointerDown callback handle it
    if (state === 'starting') {
      pendingEndRef.current = true;
      return;
    }

    // Case 2: In 'active' phase - transition to 'finishing' and complete
    if (state === 'active') {
      strokeStateRef.current = 'finishing';
      await finalizeStroke();
      return;
    }

    // Case 3: 'idle' or 'finishing' - ignore (already handled or never started)
  }, [finalizeStroke]);

  /**
   * Initialize brush stroke asynchronously.
   * Handles state transitions and replaying buffered input.
   */
  const initializeBrushStroke = useCallback(async () => {
    try {
      await beginBrushStroke(brushHardness);

      // Check if cancelled or state changed during await
      if (strokeStateRef.current !== 'starting') {
        return;
      }

      // Transition to 'active' state
      strokeStateRef.current = 'active';
      window.__strokeDiagnostics?.onStateChange('active');

      // Replay all buffered points
      const points = pendingPointsRef.current;
      for (const p of points) {
        processBrushPointWithConfig(p.x, p.y, p.pressure, p.pointIndex);
        window.__strokeDiagnostics?.onPointBuffered();
      }
      pendingPointsRef.current = [];

      // If pendingEnd flag was set during 'starting' phase, finish immediately
      if (pendingEndRef.current) {
        strokeStateRef.current = 'finishing';
        await finalizeStroke();
      }
    } catch (err) {
      console.error('Failed to begin stroke:', err);
      // Reset state on error to avoid sticking in 'starting'
      strokeStateRef.current = 'idle';
      pendingPointsRef.current = [];
      isDrawingRef.current = false;
    }
  }, [beginBrushStroke, brushHardness, finalizeStroke, processBrushPointWithConfig]);

  // Handle pointer down events
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;

      // Handle Panning (Space key)
      if (spacePressed) {
        setIsPanning(true);
        panStartRef.current = { x: e.clientX, y: e.clientY };
        return;
      }

      // Handle Zoom tool
      if (currentTool === 'zoom') {
        isZoomingRef.current = true;
        zoomStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          startScale: scale,
        };
        container.setPointerCapture(e.pointerId);
        return;
      }

      // Prepare input data
      const pressure = e.pressure > 0 ? e.pressure : 0.5;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const canvasX = (e.clientX - rect.left) / scale;
      const canvasY = (e.clientY - rect.top) / scale;

      // Handle Eyedropper
      if (currentTool === 'eyedropper') {
        pickColorAt(canvasX, canvasY);
        return;
      }

      // Check Layer Validation
      const activeLayer = layers.find((l) => l.id === activeLayerId);
      if (!activeLayerId || !activeLayer?.visible) return;

      // Start Drawing
      canvas.setPointerCapture(e.pointerId);
      isDrawingRef.current = true;
      strokeBufferRef.current.reset();

      // Capture layer state before stroke starts (for undo)
      captureBeforeImage();

      // Brush Tool: Use State Machine Logic
      if (currentTool === 'brush') {
        const idx = pointIndexRef.current++;
        latencyProfilerRef.current.markInputReceived(idx, e.nativeEvent as PointerEvent);

        strokeStateRef.current = 'starting';
        pendingPointsRef.current = [{ x: canvasX, y: canvasY, pressure, pointIndex: idx }];
        pendingEndRef.current = false;

        // Start initialization (fire-and-forget)
        window.__strokeDiagnostics?.onStrokeStart();
        void initializeBrushStroke();
        return;
      }

      // Eraser/Other Tools: Legacy Logic
      const point: Point = {
        x: canvasX,
        y: canvasY,
        pressure,
        tiltX: e.tiltX ?? 0,
        tiltY: e.tiltY ?? 0,
      };

      const interpolatedPoints = strokeBufferRef.current.addPoint(point);
      if (interpolatedPoints.length > 0) {
        drawPoints(interpolatedPoints);
      }
    },
    [
      spacePressed,
      currentTool,
      scale,
      pickColorAt,
      layers,
      activeLayerId,
      captureBeforeImage,
      initializeBrushStroke,
      drawPoints,
      setIsPanning,
    ]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      // 获取所有合并事件（包括被浏览器合并的中间事件）
      // 在 Release 模式下，浏览器会更激进地合并事件，导致采样点不足
      const coalescedEvents = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [
        e.nativeEvent,
      ];

      // 平移模式：只使用最后一个事件
      if (isPanning && panStartRef.current) {
        const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? e.nativeEvent;
        const deltaX = lastEvent.clientX - panStartRef.current.x;
        const deltaY = lastEvent.clientY - panStartRef.current.y;
        pan(deltaX, deltaY);
        panStartRef.current = { x: lastEvent.clientX, y: lastEvent.clientY };
        // Note: cursor position is updated by native event listener
        return;
      }

      // Zoom logic
      if (isZoomingRef.current && zoomStartRef.current) {
        const lastEvent = coalescedEvents[coalescedEvents.length - 1] ?? e.nativeEvent;
        const deltaX = lastEvent.clientX - zoomStartRef.current.x;

        // Scrubby zoom: 100px drag doubles/halves scale
        const zoomFactor = 1 + deltaX * 0.01;
        const newScale = zoomStartRef.current.startScale * zoomFactor;

        // Retrieve container rect to convert initial mouse to container coords
        // Zoom anchored to the initial click position
        const container = containerRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          const initialClickX = zoomStartRef.current.x - rect.left;
          const initialClickY = zoomStartRef.current.y - rect.top;
          setScale(newScale, initialClickX, initialClickY);
        }

        return;
      }

      // Note: cursor position is updated by native event listener for zero-lag

      // 绘画模式
      if (!isDrawingRef.current) return;

      // Q1 Optimization: Skip brush input if pointerrawupdate is handling it
      // pointerrawupdate provides lower-latency input (1-3ms improvement)
      if (currentTool === 'brush' && usingRawInput.current) {
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const tabletState = useTabletStore.getState();
      const isWinTabActive = tabletState.isStreaming && tabletState.backend === 'WinTab';
      // Drain input buffer once per frame/event-batch (outside the loop)
      const bufferedPoints = isWinTabActive ? drainPointBuffer() : [];

      // 遍历所有合并事件，恢复完整输入轨迹
      for (const evt of coalescedEvents) {
        // 始终使用 PointerEvent 的坐标（它们是准确的屏幕坐标）
        const canvasX = (evt.clientX - rect.left) / scale;
        const canvasY = (evt.clientY - rect.top) / scale;

        // Resolve input pressure/tilt (handling WinTab buffering if active)
        const { pressure, tiltX, tiltY } = getEffectiveInputData(
          evt,
          isWinTabActive,
          bufferedPoints,
          tabletState.currentPoint
        );

        const idx = pointIndexRef.current++;
        // Note: evt is PointerEvent here
        latencyProfilerRef.current.markInputReceived(idx, evt as PointerEvent);

        // For brush tool, use state machine + input buffering
        if (currentTool === 'brush') {
          const state = strokeStateRef.current;
          if (state === 'starting') {
            // Buffer points during 'starting' phase, replay after beginStroke completes
            pendingPointsRef.current.push({ x: canvasX, y: canvasY, pressure, pointIndex: idx });
            window.__strokeDiagnostics?.onPointBuffered(); // Telemetry: Buffered point
          } else if (state === 'active') {
            inputQueueRef.current.push({ x: canvasX, y: canvasY, pressure, pointIndex: idx });
            window.__strokeDiagnostics?.onPointBuffered();
          }
          // Ignore in 'idle' or 'finishing' state
          continue;
        }

        // For eraser, use the legacy stroke buffer
        const point: Point = {
          x: canvasX,
          y: canvasY,
          pressure,
          tiltX,
          tiltY,
        };

        const interpolatedPoints = strokeBufferRef.current.addPoint(point);
        if (interpolatedPoints.length > 0) {
          drawPoints(interpolatedPoints);
        }
      }
    },
    [isPanning, pan, drawPoints, scale, setScale, currentTool, usingRawInput]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      // 结束平移
      if (isPanning) {
        setIsPanning(false);
        panStartRef.current = null;
        return;
      }

      // Finish zooming
      if (isZoomingRef.current) {
        isZoomingRef.current = false;
        zoomStartRef.current = null;
        const container = containerRef.current;
        if (container) {
          container.releasePointerCapture(e.pointerId);
        }
        return;
      }

      // 结束绘画
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.releasePointerCapture(e.pointerId);
      }

      // 完成当前笔触
      finishCurrentStroke();
    },
    [isPanning, setIsPanning, finishCurrentStroke]
  );

  // 键盘事件处理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 优先处理修饰键组合 (Undo/Redo)
      if (e.ctrlKey || e.metaKey) {
        if (e.code === 'KeyZ') {
          e.preventDefault();
          if (e.shiftKey) {
            handleRedo();
          } else {
            handleUndo();
          }
        } else if (e.code === 'KeyY') {
          e.preventDefault();
          handleRedo();
        }
        return;
      }

      // 忽略不需要重复触发的按键 (除了 [] 笔刷大小调节)
      const isBracket = e.code === 'BracketLeft' || e.code === 'BracketRight';
      if (e.repeat && !isBracket) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          setSpacePressed(true);
          break;

        case 'AltLeft':
        case 'AltRight':
          if (!altPressed) {
            // 如果正在绘制，先强制结束当前笔触
            if (isDrawingRef.current) finishCurrentStroke();

            e.preventDefault();
            setAltPressed(true);
            previousToolRef.current = currentTool;
            setTool('eyedropper');
          }
          break;

        case 'KeyZ':
          if (!e.altKey) {
            e.preventDefault();
            if (currentTool !== 'zoom') setTool('zoom');
          }
          break;

        case 'BracketLeft':
          e.preventDefault();
          setCurrentSize(currentSize - (e.shiftKey ? 10 : 5));
          break;

        case 'BracketRight':
          e.preventDefault();
          setCurrentSize(currentSize + (e.shiftKey ? 10 : 5));
          break;

        case 'KeyB':
          if (!e.altKey) {
            e.preventDefault();
            setTool('brush');
          }
          break;

        case 'KeyE':
          if (!e.altKey) {
            e.preventDefault();
            setTool('eraser');
          }
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacePressed(false);
        setIsPanning(false);
        panStartRef.current = null;
      }

      // Release Alt: restore previous tool
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        setAltPressed(false);
        if (previousToolRef.current) {
          setTool(previousToolRef.current as ToolType);
          previousToolRef.current = null;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [
    setIsPanning,
    handleUndo,
    handleRedo,
    altPressed,
    currentTool,
    setTool,
    currentSize,
    setCurrentSize,
    finishCurrentStroke,
  ]);

  // 计算 viewport 变换样式
  const viewportStyle: React.CSSProperties = {
    transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
    transformOrigin: '0 0',
  };

  // Calculate clip-path for checkerboard
  const x = offsetX;
  const y = offsetY;
  const w = width * scale;
  const h = height * scale;
  const clipPathKey = `polygon(${x}px ${y}px, ${x + w}px ${y}px, ${x + w}px ${y + h}px, ${x}px ${y + h}px)`;

  return (
    <div
      ref={containerRef}
      className="canvas-container"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      // Note: onPointerEnter cursor handling is done by native event listener
      style={{ cursor: cursorStyle }}
    >
      <div className="canvas-checkerboard" style={{ clipPath: clipPathKey }} />
      <div className="canvas-viewport" style={viewportStyle}>
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          className="main-canvas"
          data-testid="main-canvas"
        />
      </div>
      {showDomCursor && (
        <div
          ref={brushCursorRef}
          className="brush-cursor"
          style={{
            width: currentSize * scale,
            height: currentSize * scale,
          }}
        />
      )}
    </div>
  );
}

import React, { useEffect, useRef, useCallback } from 'react';
import { useToolStore, ToolType } from '@/stores/tool';
import { useSelectionStore } from '@/stores/selection';
import { useDocumentStore } from '@/stores/document';
import { useViewportStore } from '@/stores/viewport';
import { useHistoryStore } from '@/stores/history';
import { useSettingsStore } from '@/stores/settings';
import { useSelectionHandler } from './useSelectionHandler';
import { useCursor } from './useCursor';
import { useBrushRenderer, BrushRenderConfig } from './useBrushRenderer';
import { useRawPointerInput } from './useRawPointerInput';
import { useAltEyedropper } from './useAltEyedropper';
import { useShiftLineMode } from './useShiftLineMode';
import { useLayerOperations } from './useLayerOperations';
import { useGlobalExports } from './useGlobalExports';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { usePointerHandlers } from './usePointerHandlers';
import { useStrokeProcessor } from './useStrokeProcessor';
import { SelectionOverlay } from './SelectionOverlay';
import { LatencyProfiler, LagometerMonitor, FPSCounter } from '@/benchmark';
import { LayerRenderer } from '@/utils/layerRenderer';
import { StrokeBuffer } from '@/utils/interpolation';

import './Canvas.css';

declare global {
  interface Window {
    __canvasFillLayer?: (color: string) => void;
    __canvasClearSelection?: () => void;
    __getLayerImageData?: (layerId: string) => Promise<string | undefined>;
    __getFlattenedImage?: () => Promise<string | undefined>;
    __getThumbnail?: () => Promise<string | undefined>;
    __loadLayerImages?: (
      layersData: Array<{ id: string; imageData?: string; offsetX?: number; offsetY?: number }>,
      benchmarkSessionId?: string
    ) => Promise<void>;
    __gpuBrushDebugRects?: boolean;
    __gpuBrushUseBatchUnionRect?: boolean;
    __strokeDiagnostics?: {
      onPointBuffered: () => void;
      onStrokeStart: () => void;
      onStrokeEnd: () => void;
      onStateChange: (state: string) => void;
    };
  }
}

type QueuedPoint = { x: number; y: number; pressure: number; pointIndex: number };

export function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDrawingRef = useRef(false);
  const brushCursorRef = useRef<HTMLDivElement>(null);
  const eyedropperCursorRef = useRef<HTMLDivElement>(null);
  const layerRendererRef = useRef<LayerRenderer | null>(null);
  const strokeBufferRef = useRef(new StrokeBuffer());
  const lagometerRef = useRef(new LagometerMonitor());
  const fpsCounterRef = useRef(new FPSCounter());
  const lastRenderedPosRef = useRef<{ x: number; y: number } | null>(null);
  const lastInputPosRef = useRef<{ x: number; y: number } | null>(null);
  const needsRenderRef = useRef(false);
  const pendingEndRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const zoomStartRef = useRef<{ x: number; y: number; startScale: number } | null>(null);
  const isZoomingRef = useRef(false);
  const previousToolRef = useRef<ToolType | null>('brush');
  const historyInitializedRef = useRef(false);

  // Input processing refs
  const strokeStateRef = useRef<string>('idle');
  const pendingPointsRef = useRef<QueuedPoint[]>([]);
  const inputQueueRef = useRef<QueuedPoint[]>([]);
  const pointIndexRef = useRef(0);

  // Profiling
  const latencyProfilerRef = useRef(new LatencyProfiler());

  // Store access
  const {
    currentTool,
    brushRoundness,
    brushAngle,
    brushTexture,
    brushColor,
    backgroundColor,
    brushOpacity,
    brushFlow,
    brushHardness,
    brushMaskType,
    brushSpacing,
    shapeDynamics,
    scatter,
    colorDynamics,
    transfer,
    wetEdge,
    wetEdgeEnabled,
    shapeDynamicsEnabled,
    scatterEnabled,
    colorDynamicsEnabled,
    transferEnabled,
    textureEnabled,
    textureSettings,
    dualBrush,
    dualBrushEnabled,
    showCrosshair,
    setTool,
    setCurrentSize,
    setBrushColor,
    pressureCurve,
    pressureFlowEnabled,
    pressureOpacityEnabled,
    pressureSizeEnabled,
  } = useToolStore();

  const { eraserSize } = useToolStore();
  const brushSize = useToolStore((s) => s.brushSize);
  const currentSize = currentTool === 'eraser' ? eraserSize : brushSize;

  const {
    brush: { renderMode },
  } = useSettingsStore();

  const { width, height, activeLayerId, layers, initDocument } = useDocumentStore();

  const { pushAddLayer } = useHistoryStore();

  const { isPanning, scale, setScale, setIsPanning, pan, zoomIn, zoomOut, offsetX, offsetY } =
    useViewportStore();

  // Selection handler for rect select and lasso tools
  const {
    handleSelectionPointerDown,
    handleSelectionPointerMove,
    handleSelectionPointerUp,
    handleSelectionDoubleClick: _handleSelectionDoubleClick,
    isSelectionToolActive,
  } = useSelectionHandler({ currentTool, scale });

  // Get selection store actions for keyboard shortcuts
  const { selectAll, deselectAll, cancelSelection } = useSelectionStore();

  // Initialize brush renderer for Flow/Opacity three-level pipeline
  const {
    beginStroke: beginBrushStroke,
    processPoint: processBrushPoint,
    endStroke: endBrushStroke,
    getPreviewCanvas,
    getPreviewOpacity,
    isStrokeActive,
    getLastDabPosition,
    getDebugRects,
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

  const isLineToolActive = currentTool === 'brush' || currentTool === 'eraser';

  const requestRender = useCallback(() => {
    needsRenderRef.current = true;
  }, []);

  const {
    getGuideLine: getShiftLineGuide,
    updateCursor: updateShiftLineCursor,
    constrainPoint: constrainShiftLinePoint,
    lockLine: lockShiftLine,
    onStrokeEnd: onShiftLineStrokeEnd,
  } = useShiftLineMode({ enabled: isLineToolActive, onInvalidate: requestRender });

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

  const {
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
  } = useLayerOperations({
    layerRendererRef,
    activeLayerId,
    layers,
    width,
    height,
    compositeAndRender,
  });

  useGlobalExports({
    layerRendererRef,
    compositeAndRender,
    fillActiveLayer,
    handleClearSelection,
    handleUndo,
    handleRedo,
    handleClearLayer,
    handleDuplicateLayer,
    handleRemoveLayer,
  });

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
      backgroundColor,
      pressureSizeEnabled,
      pressureFlowEnabled,
      pressureOpacityEnabled,
      pressureCurve,
      texture: brushTexture,
      shapeDynamicsEnabled,
      shapeDynamics,
      scatterEnabled,
      scatter,
      colorDynamicsEnabled,
      colorDynamics,
      wetEdgeEnabled,
      wetEdge,
      transferEnabled,
      transfer,
      textureEnabled,
      textureSettings,
      dualBrushEnabled,
      dualBrush,
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
    backgroundColor,
    pressureSizeEnabled,
    pressureFlowEnabled,
    pressureOpacityEnabled,
    pressureCurve,
    brushTexture,
    shapeDynamicsEnabled,
    shapeDynamics,
    scatterEnabled,
    scatter,
    colorDynamicsEnabled,
    colorDynamics,
    wetEdgeEnabled,
    wetEdge,
    transferEnabled,
    transfer,
    textureEnabled,
    textureSettings,
    dualBrushEnabled,
    dualBrush,
  ]);

  const { drawPoints, finishCurrentStroke, initializeBrushStroke } = useStrokeProcessor({
    canvasRef,
    layerRendererRef,
    width,
    height,
    scale,
    activeLayerId,
    currentTool,
    currentSize,
    brushColor,
    brushOpacity,
    pressureCurve,
    brushHardness,
    wetEdge,
    wetEdgeEnabled,
    getBrushConfig,
    getShiftLineGuide,
    constrainShiftLinePoint,
    onShiftLineStrokeEnd,
    isDrawingRef,
    strokeBufferRef,
    strokeStateRef,
    pendingPointsRef,
    inputQueueRef,
    lastRenderedPosRef,
    lastInputPosRef,
    needsRenderRef,
    pendingEndRef,
    lagometerRef,
    fpsCounterRef,
    latencyProfilerRef,
    beginBrushStroke,
    processBrushPoint,
    endBrushStroke,
    getPreviewCanvas,
    getPreviewOpacity,
    isStrokeActive,
    getLastDabPosition,
    getDebugRects,
    flushPending,
    compositeAndRender,
    saveStrokeToHistory,
    updateThumbnail,
  });

  // Alt eyedropper switching - must be after finishCurrentStroke to avoid TDZ
  useAltEyedropper(previousToolRef, finishCurrentStroke);

  const { spacePressed } = useKeyboardShortcuts({
    currentTool,
    currentSize,
    setTool,
    setCurrentSize,
    handleUndo,
    handleRedo,
    selectAll,
    deselectAll,
    cancelSelection,
    width,
    height,
    setIsPanning,
    panStartRef,
  });

  const { cursorStyle, showDomCursor, showEyedropperDomCursor } = useCursor({
    currentTool,
    currentSize,
    scale,
    showCrosshair,
    spacePressed,
    isPanning,
    containerRef,
    brushCursorRef,
    eyedropperCursorRef,
    brushRoundness,
    brushAngle,
    brushTexture: brushTexture
      ? {
          cursorPath: brushTexture.cursorPath,
          cursorBounds: brushTexture.cursorBounds,
        }
      : null,
    canvasRef,
  });

  const { handlePointerDown, handlePointerMove, handlePointerUp } = usePointerHandlers({
    containerRef,
    canvasRef,
    currentTool,
    scale,
    spacePressed,
    isPanning,
    setIsPanning,
    panStartRef,
    pan,
    isZoomingRef,
    zoomStartRef,
    setScale,
    setBrushColor,
    width,
    height,
    layers,
    activeLayerId,
    captureBeforeImage,
    initializeBrushStroke,
    drawPoints,
    finishCurrentStroke,
    isSelectionToolActive,
    handleSelectionPointerDown,
    handleSelectionPointerMove,
    handleSelectionPointerUp,
    updateShiftLineCursor,
    lockShiftLine,
    constrainShiftLinePoint,
    usingRawInput,
    isDrawingRef,
    strokeBufferRef,
    strokeStateRef,
    pendingPointsRef,
    inputQueueRef,
    pointIndexRef,
    pendingEndRef,
    lastInputPosRef,
    latencyProfilerRef,
  });

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
      <SelectionOverlay scale={scale} offsetX={offsetX} offsetY={offsetY} />
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
          className={`brush-cursor ${brushTexture?.cursorPath ? 'brush-cursor--texture' : ''}`}
          style={{
            width: currentSize * scale,
            height: currentSize * scale * (brushRoundness / 100),
            // Note: position transform is set by useCursor via JS
            // rotation is applied to inner content, not the container
          }}
        >
          {brushTexture?.cursorPath ? (
            <svg
              key={brushTexture.cursorPath.slice(0, 50)}
              width="100%"
              height="100%"
              viewBox="-0.5 -0.5 1 1"
              preserveAspectRatio="none"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                overflow: 'visible',
                transform: `rotate(${brushAngle}deg)`,
              }}
            >
              {/* Use vector-effect to keep stroke width constant regardless of viewBox scale */}
              <path
                d={brushTexture.cursorPath}
                fill="none"
                stroke="rgba(255,255,255,0.9)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={brushTexture.cursorPath}
                fill="none"
                stroke="rgba(0,0,0,0.8)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          ) : (
            // For non-texture brushes, apply rotation via pseudo-element in CSS
            <div
              className="brush-cursor__ellipse"
              style={{
                width: '100%',
                height: '100%',
                borderRadius: '50%',
                border: '1px solid var(--border-strong)',
                boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.5)',
                transform: `rotate(${brushAngle}deg)`,
              }}
            />
          )}
        </div>
      )}
      {showEyedropperDomCursor && (
        <div
          ref={eyedropperCursorRef}
          className="eyedropper-cursor"
          style={{
            position: 'fixed',
            left: 0,
            top: 0,
            pointerEvents: 'none',
            zIndex: 'var(--z-overlay)',
            width: 24,
            height: 24,
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="m2 22 1-1h3l9-9"
              stroke="black"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="m2 22 1-1h3l9-9"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M3 21v-3l9-9"
              stroke="black"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M3 21v-3l9-9"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"
              stroke="black"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"
              fill="white"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}
    </div>
  );
}

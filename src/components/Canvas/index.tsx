import { useRef, useEffect, useCallback, useState } from 'react';
import { useDocumentStore } from '@/stores/document';
import { useToolStore, applyPressureCurve, ToolType } from '@/stores/tool';
import { useViewportStore } from '@/stores/viewport';
import { useHistoryStore } from '@/stores/history';
import { useTabletStore, drainPointBuffer, clearPointBuffer } from '@/stores/tablet';
import { StrokeBuffer, Point } from '@/utils/interpolation';
import { LayerRenderer } from '@/utils/layerRenderer';
import './Canvas.css';

export function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDrawingRef = useRef(false);
  const strokeBufferRef = useRef<StrokeBuffer>(new StrokeBuffer(2));
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const layerRendererRef = useRef<LayerRenderer | null>(null);

  const [spacePressed, setSpacePressed] = useState(false);
  const [altPressed, setAltPressed] = useState(false);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const previousToolRef = useRef<string | null>(null);

  const { width, height, layers, activeLayerId, initDocument } = useDocumentStore((s) => ({
    width: s.width,
    height: s.height,
    layers: s.layers,
    activeLayerId: s.activeLayerId,
    initDocument: s.initDocument,
  }));

  const {
    currentTool,
    brushSize,
    eraserSize,
    brushColor,
    brushOpacity,
    pressureCurve,
    setCurrentSize,
    setBrushColor,
    setTool,
  } = useToolStore((s) => ({
    currentTool: s.currentTool,
    brushSize: s.brushSize,
    eraserSize: s.eraserSize,
    brushColor: s.brushColor,
    brushOpacity: s.brushOpacity,
    pressureCurve: s.pressureCurve,
    setCurrentSize: s.setCurrentSize,
    setBrushColor: s.setBrushColor,
    setTool: s.setTool,
  }));

  // Get current tool size (brush or eraser)
  const currentSize = currentTool === 'eraser' ? eraserSize : brushSize;

  const { scale, offsetX, offsetY, isPanning, zoomIn, zoomOut, pan, setIsPanning } =
    useViewportStore();

  const { pushState, undo, redo } = useHistoryStore();

  // Tablet store: We use getState() directly in event handlers for real-time data
  // No need to subscribe to state changes here since we sync-read in handlers

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

  // Save canvas state to history
  const saveToHistory = useCallback(() => {
    const renderer = layerRendererRef.current;
    if (!renderer || !activeLayerId) return;

    const imageData = renderer.getLayerImageData(activeLayerId);
    if (imageData) {
      pushState(imageData);
    }
  }, [pushState, activeLayerId]);

  // Restore canvas from ImageData
  const restoreCanvas = useCallback(
    (imageData: ImageData) => {
      const renderer = layerRendererRef.current;
      if (!renderer || !activeLayerId) return;

      renderer.setLayerImageData(activeLayerId, imageData);
      compositeAndRender();
    },
    [activeLayerId, compositeAndRender]
  );

  // Handle undo
  const handleUndo = useCallback(() => {
    const state = undo();
    if (state) {
      restoreCanvas(state.imageData);
    }
  }, [undo, restoreCanvas]);

  // Handle redo
  const handleRedo = useCallback(() => {
    const state = redo();
    if (state) {
      restoreCanvas(state.imageData);
    }
  }, [redo, restoreCanvas]);

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

    // Save current state before clearing
    saveToHistory();

    // Clear the layer
    renderer.clearLayer(activeLayerId);
    compositeAndRender();

    // Save new state after clearing
    saveToHistory();
  }, [activeLayerId, saveToHistory, compositeAndRender]);

  // Expose undo/redo/clearLayer handlers globally for toolbar
  useEffect(() => {
    const win = window as Window & {
      __canvasUndo?: () => void;
      __canvasRedo?: () => void;
      __canvasClearLayer?: () => void;
    };
    win.__canvasUndo = handleUndo;
    win.__canvasRedo = handleRedo;
    win.__canvasClearLayer = handleClearLayer;

    return () => {
      delete win.__canvasUndo;
      delete win.__canvasRedo;
      delete win.__canvasClearLayer;
    };
  }, [handleUndo, handleRedo, handleClearLayer]);

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
          fillColor: layer.name === 'Background' ? '#ffffff' : undefined,
        });
      } else {
        // Update existing layer properties
        renderer.updateLayer(layer.id, {
          visible: layer.visible,
          opacity: layer.opacity,
          blendMode: layer.blendMode,
        });
      }
    }

    // Update layer order
    renderer.setLayerOrder(layers.map((l) => l.id));

    // Initial composite render
    compositeAndRender();

    // Save initial state to history for active layer
    if (activeLayerId) {
      const imageData = renderer.getLayerImageData(activeLayerId);
      if (imageData) {
        pushState(imageData);
      }
    }
  }, [layers, width, height, activeLayerId, compositeAndRender, pushState]);

  // Re-composite when layer visibility/opacity changes
  useEffect(() => {
    compositeAndRender();
  }, [layers, compositeAndRender]);

  // 键盘事件：空格键平移 + 撤销/重做 + 笔刷大小 + Alt取色
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Space for panning
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        setSpacePressed(true);
        return;
      }

      // Alt for eyedropper (temporary tool switch)
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        if (!e.repeat && !altPressed) {
          e.preventDefault();
          setAltPressed(true);
          previousToolRef.current = currentTool;
          setTool('eyedropper');
        }
        return;
      }

      // Brush/eraser size: [ to decrease, ] to increase
      if (e.code === 'BracketLeft') {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 5;
        setCurrentSize(Math.max(1, currentSize - step));
        return;
      }
      if (e.code === 'BracketRight') {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 5;
        setCurrentSize(Math.min(500, currentSize + step));
        return;
      }

      // Tool switching: B for brush, E for eraser
      if (e.code === 'KeyB' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setTool('brush');
        return;
      }
      if (e.code === 'KeyE' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setTool('eraser');
        return;
      }

      // Ctrl+Z for undo
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Ctrl+Y or Ctrl+Shift+Z for redo
      if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
        return;
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
  ]);

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

  // 绘制插值后的点序列
  const drawPoints = useCallback(
    (points: Point[]) => {
      const ctx = getActiveLayerCtx();
      if (!ctx || points.length < 2) return;

      const isEraser = currentTool === 'eraser';

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
          // Eraser: use destination-out to erase to transparency
          ctx.globalCompositeOperation = 'destination-out';
          ctx.strokeStyle = 'rgba(0,0,0,1)';
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
    ]
  );

  // 指针事件处理
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;

      // PointerDown 时刻，WinTab 数据可能还未通过 Tauri 事件到达前端
      // 因此优先使用 PointerEvent.pressure（Windows Ink 提供的压感）
      // WinTab 数据将在后续的 PointerMove 中使用
      const pressure = e.pressure > 0 ? e.pressure : 0.5;
      const tiltX = e.tiltX ?? 0;
      const tiltY = e.tiltY ?? 0;

      // 平移模式
      if (spacePressed) {
        setIsPanning(true);
        panStartRef.current = { x: e.clientX, y: e.clientY };
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const canvasX = (e.clientX - rect.left) / scale;
      const canvasY = (e.clientY - rect.top) / scale;

      // Eyedropper mode: pick color and return
      if (currentTool === 'eyedropper') {
        pickColorAt(canvasX, canvasY);
        return;
      }

      // Drawing/erasing mode
      if (!activeLayerId) return;

      canvas.setPointerCapture(e.pointerId);
      isDrawingRef.current = true;
      strokeBufferRef.current.reset();

      const point: Point = {
        x: canvasX,
        y: canvasY,
        pressure,
        tiltX,
        tiltY,
      };

      strokeBufferRef.current.addPoint(point);
    },
    [spacePressed, setIsPanning, scale, activeLayerId, currentTool, pickColorAt]
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
        setCursorPos({ x: e.clientX, y: e.clientY });
        return;
      }

      // Update cursor position for brush size indicator
      setCursorPos({ x: e.clientX, y: e.clientY });

      // 绘画模式
      if (!isDrawingRef.current) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const tabletState = useTabletStore.getState();
      const isWinTabActive = tabletState.isStreaming && tabletState.backend === 'WinTab';

      // 遍历所有合并事件，恢复完整输入轨迹
      for (const evt of coalescedEvents) {
        // 始终使用 PointerEvent 的坐标（它们是准确的屏幕坐标）
        const canvasX = (evt.clientX - rect.left) / scale;
        const canvasY = (evt.clientY - rect.top) / scale;

        // 获取压力数据
        let pressure: number;
        let tiltX: number;
        let tiltY: number;

        if (isWinTabActive) {
          // WinTab 模式：从缓冲区获取最新的压力数据
          // 消费所有缓冲的点，使用最后一个有效压力值
          const bufferedPoints = drainPointBuffer();
          let latestPressure = 0;
          let latestTiltX = 0;
          let latestTiltY = 0;

          // 找到最后一个有压力的点
          for (let i = bufferedPoints.length - 1; i >= 0; i--) {
            const p = bufferedPoints[i];
            if (p && p.pressure > 0) {
              latestPressure = p.pressure;
              latestTiltX = p.tilt_x;
              latestTiltY = p.tilt_y;
              break;
            }
          }

          // 如果缓冲区没有有效数据，使用 currentPoint
          if (
            latestPressure === 0 &&
            tabletState.currentPoint &&
            tabletState.currentPoint.pressure > 0
          ) {
            latestPressure = tabletState.currentPoint.pressure;
            latestTiltX = tabletState.currentPoint.tilt_x;
            latestTiltY = tabletState.currentPoint.tilt_y;
          }

          // 如果 WinTab 没有有效压力，回退到 PointerEvent
          if (latestPressure > 0) {
            pressure = latestPressure;
            tiltX = latestTiltX;
            tiltY = latestTiltY;
          } else {
            pressure = evt.pressure > 0 ? evt.pressure : 0.5;
            tiltX = (evt as PointerEvent).tiltX ?? 0;
            tiltY = (evt as PointerEvent).tiltY ?? 0;
          }
        } else {
          // PointerEvent 模式
          pressure = evt.pressure > 0 ? evt.pressure : 0.5;
          tiltX = (evt as PointerEvent).tiltX ?? 0;
          tiltY = (evt as PointerEvent).tiltY ?? 0;
        }

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
    [isPanning, pan, drawPoints, scale]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      // 结束平移
      if (isPanning) {
        setIsPanning(false);
        panStartRef.current = null;
        return;
      }

      // 结束绘画
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.releasePointerCapture(e.pointerId);
      }

      // 绘制剩余的插值点
      if (isDrawingRef.current) {
        // 清理 WinTab 缓冲区
        clearPointBuffer();

        const remainingPoints = strokeBufferRef.current.finish();
        if (remainingPoints.length > 0) {
          drawPoints(remainingPoints);
        }

        // Save state to history after stroke completes
        saveToHistory();
      }

      isDrawingRef.current = false;
    },
    [isPanning, setIsPanning, drawPoints, saveToHistory]
  );

  // 计算 viewport 变换样式
  const viewportStyle: React.CSSProperties = {
    transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
    transformOrigin: '0 0',
  };

  // 根据模式设置光标
  const getCursor = () => {
    if (spacePressed || isPanning) return 'grab';
    if (currentTool === 'eyedropper') return 'crosshair';
    if (currentTool === 'move') return 'move';
    // Hide cursor for brush/eraser - we show custom cursor
    if (currentTool === 'brush' || currentTool === 'eraser') return 'none';
    return 'crosshair';
  };

  // Show brush cursor for brush and eraser tools
  const showBrushCursor =
    (currentTool === 'brush' || currentTool === 'eraser') &&
    cursorPos &&
    !spacePressed &&
    !isPanning;

  return (
    <div
      ref={containerRef}
      className="canvas-container"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={(e) => {
        handlePointerUp(e);
        setCursorPos(null);
      }}
      onPointerEnter={(e) => {
        setCursorPos({ x: e.clientX, y: e.clientY });
      }}
      style={{ cursor: getCursor() }}
    >
      <div className="canvas-viewport" style={viewportStyle}>
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          className="main-canvas"
          data-testid="main-canvas"
        />
      </div>
      {showBrushCursor && (
        <div
          className="brush-cursor"
          style={{
            left: cursorPos.x,
            top: cursorPos.y,
            width: currentSize * scale,
            height: currentSize * scale,
          }}
        />
      )}
    </div>
  );
}

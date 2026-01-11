import { useRef, useEffect, useCallback, useState } from 'react';
import { useDocumentStore } from '@/stores/document';
import { useToolStore, applyPressureCurve } from '@/stores/tool';
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

  const { width, height, layers, activeLayerId, initDocument } = useDocumentStore((s) => ({
    width: s.width,
    height: s.height,
    layers: s.layers,
    activeLayerId: s.activeLayerId,
    initDocument: s.initDocument,
  }));

  const { brushSize, brushColor, brushOpacity, pressureCurve } = useToolStore((s) => ({
    brushSize: s.brushSize,
    brushColor: s.brushColor,
    brushOpacity: s.brushOpacity,
    pressureCurve: s.pressureCurve,
  }));

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

  // Expose undo/redo handlers globally for toolbar
  useEffect(() => {
    (window as Window & { __canvasUndo?: () => void; __canvasRedo?: () => void }).__canvasUndo =
      handleUndo;
    (window as Window & { __canvasUndo?: () => void; __canvasRedo?: () => void }).__canvasRedo =
      handleRedo;

    return () => {
      delete (window as Window & { __canvasUndo?: () => void; __canvasRedo?: () => void })
        .__canvasUndo;
      delete (window as Window & { __canvasUndo?: () => void; __canvasRedo?: () => void })
        .__canvasRedo;
    };
  }, [handleUndo, handleRedo]);

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

  // 键盘事件：空格键平移 + 撤销/重做快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Space for panning
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        setSpacePressed(true);
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
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [setIsPanning, handleUndo, handleRedo]);

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

      for (let i = 1; i < points.length; i++) {
        const from = points[i - 1];
        const to = points[i];

        if (!from || !to) continue;

        // 应用压感曲线后计算线条粗细
        const adjustedPressure = applyPressureCurve(to.pressure, pressureCurve);
        const size = brushSize * adjustedPressure;
        const opacity = brushOpacity * adjustedPressure;

        ctx.globalAlpha = opacity;
        ctx.strokeStyle = brushColor;
        ctx.lineWidth = Math.max(1, size);

        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }

      // Update composite display
      compositeAndRender();
    },
    [brushSize, brushColor, brushOpacity, pressureCurve, getActiveLayerCtx, compositeAndRender]
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

      // 绘画模式
      const canvas = canvasRef.current;
      if (!canvas || !activeLayerId) return;

      canvas.setPointerCapture(e.pointerId);
      isDrawingRef.current = true;
      strokeBufferRef.current.reset();

      const rect = canvas.getBoundingClientRect();
      // 转换为画布坐标（考虑缩放）
      const point: Point = {
        x: (e.clientX - rect.left) / scale,
        y: (e.clientY - rect.top) / scale,
        pressure,
        tiltX,
        tiltY,
      };

      strokeBufferRef.current.addPoint(point);
    },
    [spacePressed, setIsPanning, scale, activeLayerId]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      // 平移模式
      if (isPanning && panStartRef.current) {
        const deltaX = e.clientX - panStartRef.current.x;
        const deltaY = e.clientY - panStartRef.current.y;
        pan(deltaX, deltaY);
        panStartRef.current = { x: e.clientX, y: e.clientY };
        return;
      }

      // 绘画模式
      if (!isDrawingRef.current) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const tabletState = useTabletStore.getState();
      const isWinTabActive = tabletState.isStreaming && tabletState.backend === 'WinTab';

      // 始终使用 PointerEvent 的坐标（它们是准确的屏幕坐标）
      const canvasX = (e.clientX - rect.left) / scale;
      const canvasY = (e.clientY - rect.top) / scale;

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
          pressure = e.pressure > 0 ? e.pressure : 0.5;
          tiltX = e.tiltX ?? 0;
          tiltY = e.tiltY ?? 0;
        }
      } else {
        // PointerEvent 模式
        pressure = e.pressure > 0 ? e.pressure : 0.5;
        tiltX = e.tiltX ?? 0;
        tiltY = e.tiltY ?? 0;
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
    if (isPanning) return 'grabbing';
    return 'crosshair';
  };

  return (
    <div
      ref={containerRef}
      className="canvas-container"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
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
    </div>
  );
}

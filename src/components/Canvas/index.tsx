import { useRef, useEffect, useCallback } from 'react';
import { useDocumentStore } from '@/stores/document';
import { useToolStore } from '@/stores/tool';
import './Canvas.css';

interface PointerData {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
}

export function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<PointerData | null>(null);

  const { width, height } = useDocumentStore((s) => ({
    width: s.width,
    height: s.height,
  }));

  const { brushSize, brushColor, brushOpacity } = useToolStore((s) => ({
    brushSize: s.brushSize,
    brushColor: s.brushColor,
    brushOpacity: s.brushOpacity,
  }));

  // 初始化 Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true, // 降低延迟
    });

    if (ctx) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctxRef.current = ctx;

      // 填充白色背景
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
  }, [width, height]);

  // 绘制笔划段
  const drawStroke = useCallback(
    (from: PointerData, to: PointerData) => {
      const ctx = ctxRef.current;
      if (!ctx) return;

      // 基于压感计算线条粗细
      const size = brushSize * to.pressure;
      const opacity = brushOpacity * to.pressure;

      ctx.globalAlpha = opacity;
      ctx.strokeStyle = brushColor;
      ctx.lineWidth = Math.max(1, size);

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    },
    [brushSize, brushColor, brushOpacity]
  );

  // 指针事件处理
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.setPointerCapture(e.pointerId);
    isDrawingRef.current = true;

    const rect = canvas.getBoundingClientRect();
    lastPointRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure || 0.5,
      tiltX: e.tiltX || 0,
      tiltY: e.tiltY || 0,
    };
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDrawingRef.current) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const currentPoint: PointerData = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        pressure: e.pressure || 0.5,
        tiltX: e.tiltX || 0,
        tiltY: e.tiltY || 0,
      };

      if (lastPointRef.current) {
        drawStroke(lastPointRef.current, currentPoint);
      }

      lastPointRef.current = currentPoint;
    },
    [drawStroke]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.releasePointerCapture(e.pointerId);
    }
    isDrawingRef.current = false;
    lastPointRef.current = null;
  }, []);

  return (
    <div className="canvas-container">
      <div className="canvas-viewport">
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          className="main-canvas"
          data-testid="main-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        />
      </div>
    </div>
  );
}

import { useRef, useEffect } from 'react';
import { useSelectionStore } from '@/stores/selection';

interface SelectionOverlayProps {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Overlay canvas for rendering marching ants selection border.
 * Separated from main canvas to avoid redrawing the entire canvas on each animation frame.
 */
export function SelectionOverlay({ scale, offsetX, offsetY }: SelectionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const {
    hasSelection,
    selectionPath,
    creationPoints,
    isCreating,
    marchingAntsOffset,
    updateMarchingAnts,
  } = useSelectionStore();

  // Get the path to render (either committed selection or creation in progress)
  const pathToRender = isCreating ? creationPoints : selectionPath;
  const shouldRender = hasSelection || (isCreating && pathToRender.length >= 2);

  // Marching ants animation loop
  useEffect(() => {
    if (!shouldRender) return;

    let rafId: number;
    const animate = () => {
      updateMarchingAnts();
      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(rafId);
  }, [shouldRender, updateMarchingAnts]);

  // Render the selection path
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!shouldRender || pathToRender.length < 2) return;

    // Save context state
    ctx.save();

    // Apply viewport transform
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // Draw path
    ctx.beginPath();
    const first = pathToRender[0];
    if (first) {
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < pathToRender.length; i++) {
        const pt = pathToRender[i];
        if (pt) {
          ctx.lineTo(pt.x, pt.y);
        }
      }
    }

    // Close path only for committed selection or freehand lasso
    if (hasSelection || pathToRender.length > 2) {
      ctx.closePath();
    }

    // Draw marching ants (dual-layer dashed line)
    ctx.setLineDash([4 / scale, 4 / scale]); // Scale-independent dash

    // White background line
    ctx.lineDashOffset = 0;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1 / scale;
    ctx.stroke();

    // Black foreground line (animated)
    ctx.lineDashOffset = -marchingAntsOffset / scale;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.stroke();

    // Restore context state
    ctx.restore();
  }, [pathToRender, hasSelection, shouldRender, marchingAntsOffset, scale, offsetX, offsetY]);

  // Get container dimensions (full viewport)
  const containerWidth = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const containerHeight = typeof window !== 'undefined' ? window.innerHeight : 1080;

  return (
    <canvas
      ref={canvasRef}
      width={containerWidth}
      height={containerHeight}
      className="selection-overlay"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 10,
      }}
    />
  );
}

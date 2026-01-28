import { useRef, useEffect, useState, useMemo } from 'react';
import { useSelectionStore, SelectionPoint } from '@/stores/selection';

interface SelectionOverlayProps {
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
  const [canvasSize, setCanvasSize] = useState({ width: 1920, height: 1080 });
  const {
    hasSelection,
    selectionPath,
    creationPoints,
    previewPoint,
    isCreating,
    marchingAntsOffset,
    updateMarchingAnts,
  } = useSelectionStore();

  // Normalize to array of paths
  const pathsToRender = useMemo(() => {
    const paths: SelectionPoint[][] = [];

    if (isCreating) {
      // Currently creating: single path + preview point
      const currentPath = previewPoint ? [...creationPoints, previewPoint] : [...creationPoints];
      if (currentPath.length >= 2) {
        paths.push(currentPath);
      }
    } else if (hasSelection) {
      // Existing selection: multiple paths
      paths.push(...selectionPath);
    }
    return paths;
  }, [isCreating, hasSelection, creationPoints, previewPoint, selectionPath]);

  const shouldRender = pathsToRender.length > 0;

  // Track container size with ResizeObserver to match canvas buffer to display size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateSize = () => {
      // Use the canvas element's actual display size (set by CSS 100%)
      const rect = canvas.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width > 0 && height > 0) {
        setCanvasSize({ width, height });
      }
    };

    // Initial size
    updateSize();

    // Observe size changes
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(canvas);

    return () => resizeObserver.disconnect();
  }, []);

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

    if (!shouldRender || pathsToRender.length === 0) return;

    // Save context state
    ctx.save();

    // Apply viewport transform to match CSS: transform: translate(offsetX, offsetY) scale(scale)
    // CSS transform order: translate first, then scale (scale doesn't affect the translation)
    // Canvas equivalent: translate, then scale
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // Draw paths
    ctx.beginPath();

    for (const path of pathsToRender) {
      if (path.length < 2) continue;

      const first = path[0];
      if (first) {
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < path.length; i++) {
          const pt = path[i];
          if (pt) {
            ctx.lineTo(pt.x, pt.y);
          }
        }
        ctx.closePath();
      }
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
  }, [pathsToRender, hasSelection, shouldRender, marchingAntsOffset, scale, offsetX, offsetY]);

  return (
    <canvas
      ref={canvasRef}
      width={canvasSize.width}
      height={canvasSize.height}
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

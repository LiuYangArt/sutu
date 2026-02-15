import { useRef, useEffect, useState, useMemo } from 'react';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';
import { useToolStore } from '@/stores/tool';
import { normalizeHex } from '@/utils/colorUtils';

interface SelectionOverlayProps {
  scale: number;
  offsetX: number;
  offsetY: number;
}

const SELECTION_PREVIEW_ALPHA_TRANSLUCENT = 0.28;
const SELECTION_PREVIEW_ALPHA_OPAQUE = 1;

function toRgbaWithAlpha(hexColor: string, alpha: number): string {
  const normalized = normalizeHex(hexColor);
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return `rgba(0, 0, 0, ${alpha})`;
  }
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function resolveSelectionPreviewAlpha(selectionPreviewTranslucent: boolean): number {
  if (selectionPreviewTranslucent) {
    return SELECTION_PREVIEW_ALPHA_TRANSLUCENT;
  }
  return SELECTION_PREVIEW_ALPHA_OPAQUE;
}

/**
 * Overlay canvas for rendering marching ants selection border.
 * Separated from main canvas to avoid redrawing the entire canvas on each animation frame.
 */
export function SelectionOverlay({ scale, offsetX, offsetY }: SelectionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1920, height: 1080 });
  const selectionAutoFillEnabled = useSettingsStore((s) => s.general.selectionAutoFillEnabled);
  const selectionPreviewTranslucent = useSettingsStore(
    (s) => s.general.selectionPreviewTranslucent
  );
  const brushColor = useToolStore((s) => s.brushColor);
  const {
    hasSelection,
    selectionPath,
    creationPoints,
    previewPoint,
    isCreating,
    marchingAntsOffset,
    updateMarchingAnts,
  } = useSelectionStore();

  // Prepare paths for existing selection (Marching Ants)
  const existingPaths = useMemo(() => {
    return hasSelection ? selectionPath : [];
  }, [hasSelection, selectionPath]);

  // Prepare path for current creation (Solid Line)
  const creatingPath = useMemo(() => {
    if (!isCreating) return null;
    return previewPoint ? [...creationPoints, previewPoint] : [...creationPoints];
  }, [isCreating, creationPoints, previewPoint]);
  const previewAlpha = resolveSelectionPreviewAlpha(selectionPreviewTranslucent);
  const creationFillStyle = useMemo(
    () => toRgbaWithAlpha(brushColor, previewAlpha),
    [brushColor, previewAlpha]
  );

  const shouldRender = existingPaths.length > 0 || (creatingPath && creatingPath.length >= 2);

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

  // Render
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!shouldRender) return;

    // Save context state
    ctx.save();

    // Apply viewport transform
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // 1. Render Existing Selection (Marching Ants)
    if (existingPaths.length > 0) {
      ctx.beginPath();
      for (const path of existingPaths) {
        if (path.length < 2) continue;
        const first = path[0];
        if (first) {
          ctx.moveTo(first.x, first.y);
          for (let i = 1; i < path.length; i++) {
            const pt = path[i];
            if (pt) ctx.lineTo(pt.x, pt.y);
          }
          ctx.closePath();
        }
      }

      // Draw marching ants
      ctx.setLineDash([4 / scale, 4 / scale]);

      // White background
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1 / scale;
      ctx.stroke();

      // Black foreground (animated)
      ctx.lineDashOffset = -marchingAntsOffset / scale;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.stroke();
    }

    // 2. Render Creation Path (Fill Preview + Solid Line)
    if (creatingPath && creatingPath.length >= 2) {
      const first = creatingPath[0];
      if (first) {
        if (selectionAutoFillEnabled && creatingPath.length >= 3) {
          ctx.beginPath();
          ctx.moveTo(first.x, first.y);
          for (let i = 1; i < creatingPath.length; i++) {
            const pt = creatingPath[i];
            if (pt) ctx.lineTo(pt.x, pt.y);
          }
          ctx.closePath();
          ctx.fillStyle = creationFillStyle;
          ctx.fill();
        }

        ctx.beginPath();
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < creatingPath.length; i++) {
          const pt = creatingPath[i];
          if (pt) ctx.lineTo(pt.x, pt.y);
        }
        // Don't close path automatically for freehand/creation unless needed
      }

      // Solid line style
      ctx.setLineDash([]);
      // White border for visibility
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 2 / scale; // Slightly thicker
      ctx.stroke();

      // Black inner line
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineWidth = 1 / scale;
      ctx.stroke();
    }

    // Restore context state
    ctx.restore();
  }, [
    existingPaths,
    creatingPath,
    shouldRender,
    marchingAntsOffset,
    scale,
    offsetX,
    offsetY,
    selectionAutoFillEnabled,
    creationFillStyle,
  ]);

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

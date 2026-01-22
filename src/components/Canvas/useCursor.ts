import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { ToolType } from '@/stores/tool';
import { useSelectionStore } from '@/stores/selection';

/** Cursor style for each tool type */
const TOOL_CURSORS: Record<ToolType, string> = {
  brush: 'none',
  eraser: 'none',
  eyedropper: 'none', // Custom SVG cursor is generated dynamically
  move: 'move',
  select: 'crosshair',
  lasso: 'crosshair',
  zoom: 'zoom-in',
};

/** Brush texture data for cursor rendering */
export interface BrushCursorTexture {
  /** Pre-computed SVG path data (normalized 0-1 coordinates) */
  cursorPath?: string;
  /** Original texture bounds for proper scaling */
  cursorBounds?: { width: number; height: number };
}

/** Stroke style for cursor outline (dual-stroke for visibility) */
interface StrokeStyle {
  outer: { color: string; width: number };
  inner: { color: string; width: number };
}

const DEFAULT_STROKE: StrokeStyle = {
  outer: { color: 'rgba(255,255,255,0.9)', width: 1.5 },
  inner: { color: 'rgba(0,0,0,0.8)', width: 1 },
};

/** Mouse-pointer-2 cursor for selection move (lucide-react icon) */
const SELECTION_MOVE_CURSOR = (() => {
  const svg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" fill="white" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `url("data:image/svg+xml;base64,${btoa(svg)}") 4 4, default`;
})();

/** Set cursor position with center offset */
const setCursorPosition = (cursor: HTMLDivElement, x: number, y: number) => {
  cursor.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
};

/** Generate crosshair SVG lines */
const generateCrosshairSvg = (cx: number, cy: number, size: number) => `
  <line x1="${cx - size}" y1="${cy}" x2="${cx + size}" y2="${cy}" stroke="black" stroke-width="2"/>
  <line x1="${cx - size}" y1="${cy}" x2="${cx + size}" y2="${cy}" stroke="white" stroke-width="1"/>
  <line x1="${cx}" y1="${cy - size}" x2="${cx + size}" y2="${cy}" stroke="black" stroke-width="2"/>
  <line x1="${cx}" y1="${cy - size}" x2="${cx + size}" y2="${cy}" stroke="white" stroke-width="1"/>
`;

/** Generate SVG content for texture brush cursor outline */
function generateTextureOutlineSvg(
  cursorPath: string,
  size: number,
  scaleY: number,
  angle: number,
  stroke: StrokeStyle = DEFAULT_STROKE
): string {
  return `
    <g transform="rotate(${angle}) scale(${size}, ${size * scaleY})">
      <path d="${cursorPath}" fill="none" stroke="${stroke.outer.color}" stroke-width="${stroke.outer.width}" vector-effect="non-scaling-stroke"/>
      <path d="${cursorPath}" fill="none" stroke="${stroke.inner.color}" stroke-width="${stroke.inner.width}" vector-effect="non-scaling-stroke"/>
    </g>
  `;
}

/** Generate SVG content for ellipse brush cursor */
function generateEllipseOutlineSvg(
  rx: number,
  ry: number,
  angle: number,
  stroke: StrokeStyle = DEFAULT_STROKE
): string {
  return `
    <g transform="rotate(${angle})">
      <ellipse rx="${rx}" ry="${ry}" fill="none" stroke="${stroke.outer.color}" stroke-width="${stroke.outer.width}"/>
      <ellipse rx="${rx}" ry="${ry}" fill="none" stroke="${stroke.inner.color}" stroke-width="${stroke.inner.width}"/>
    </g>
  `;
}

interface UseCursorProps {
  currentTool: ToolType;
  currentSize: number;
  scale: number;
  showCrosshair: boolean;
  spacePressed: boolean;
  isPanning: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
  brushCursorRef: React.RefObject<HTMLDivElement>;
  eyedropperCursorRef: React.RefObject<HTMLDivElement>;
  /** Brush roundness (1-100, 100 = perfect circle) */
  brushRoundness?: number;
  /** Brush angle in degrees (0-360) */
  brushAngle?: number;
  /** Texture cursor data (for ABR brushes) */
  brushTexture?: BrushCursorTexture | null;
  /** Canvas ref for coordinate conversion (selection cursor) */
  canvasRef?: React.RefObject<HTMLCanvasElement>;
}

export function useCursor({
  currentTool,
  currentSize,
  scale,
  showCrosshair,
  spacePressed,
  isPanning,
  containerRef,
  brushCursorRef,
  eyedropperCursorRef,
  brushRoundness = 100,
  brushAngle = 0,
  brushTexture,
  canvasRef,
}: UseCursorProps) {
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null);

  // Track if cursor is hovering over selection bounds
  const [isOverSelection, setIsOverSelection] = useState(false);

  // Get selection state
  const { hasSelection, isPointInSelection, isCreating: isCreatingSelection } = useSelectionStore();

  const isBrushTool = currentTool === 'brush' || currentTool === 'eraser';
  const isSelectionTool = currentTool === 'select' || currentTool === 'lasso';
  const isInteracting = spacePressed || isPanning;
  const screenBrushSize = currentSize * scale;

  // Windows cursor size limit varies (32-128px), 96px is safe threshold
  const HARDWARE_CURSOR_MAX_SIZE = 96;
  const shouldUseHardwareCursor =
    isBrushTool && screenBrushSize <= HARDWARE_CURSOR_MAX_SIZE && !isInteracting;

  // Check if mouse position is inside selection (for move cursor)
  const checkSelectionHover = useCallback(
    (clientX: number, clientY: number) => {
      if (!isSelectionTool || !hasSelection || isCreatingSelection || !canvasRef?.current) {
        setIsOverSelection(false);
        return;
      }

      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();
      const canvasX = (clientX - rect.left) / scale;
      const canvasY = (clientY - rect.top) / scale;

      // Use isPointInSelection to check actual mask, not just bounding box
      setIsOverSelection(isPointInSelection(canvasX, canvasY));
    },
    [isSelectionTool, hasSelection, isCreatingSelection, canvasRef, scale, isPointInSelection]
  );

  // Generate SVG cursor URL synchronously using useMemo
  const hardwareCursorStyle = useMemo(() => {
    if (!shouldUseHardwareCursor) {
      return '';
    }

    const r = screenBrushSize / 2;
    // Roundness affects Y-axis scale (100 = circle, 1 = flat line)
    const scaleY = Math.max(brushRoundness, 1) / 100;
    // Calculate bounding box after rotation to ensure cursor fits
    const angleRad = (brushAngle * Math.PI) / 180;
    const cosA = Math.abs(Math.cos(angleRad));
    const sinA = Math.abs(Math.sin(angleRad));
    const ry = r * scaleY;
    // Rotated ellipse bounding box
    const boundWidth = 2 * (r * cosA + ry * sinA);
    const boundHeight = 2 * (r * sinA + ry * cosA);
    const maxBound = Math.max(boundWidth, boundHeight);
    // Add padding to avoid clipping
    const canvasSize = Math.ceil(maxBound + 4);
    const center = canvasSize / 2;

    let shapeContent: string;

    if (brushTexture?.cursorPath) {
      // Texture brush: use shared generator
      shapeContent = `<g transform="translate(${center}, ${center})">${generateTextureOutlineSvg(brushTexture.cursorPath, screenBrushSize, scaleY, brushAngle)}</g>`;
    } else {
      // Round brush: use shared generator
      shapeContent = `<g transform="translate(${center}, ${center})">${generateEllipseOutlineSvg(r, ry, brushAngle)}</g>`;
    }

    // Generate crosshair if enabled
    const crosshairContent = showCrosshair ? generateCrosshairSvg(center, center, 8) : '';

    const svg = `
      <svg width="${canvasSize}" height="${canvasSize}" viewBox="0 0 ${canvasSize} ${canvasSize}" xmlns="http://www.w3.org/2000/svg">
        ${shapeContent}
        ${crosshairContent}
      </svg>
    `;

    const cursorUrl = `data:image/svg+xml;base64,${btoa(svg)}`;
    // Use 'none' as fallback to prevent crosshair flash during cursor image loading
    return `url("${cursorUrl}") ${center} ${center}, none`;
  }, [
    shouldUseHardwareCursor,
    screenBrushSize,
    showCrosshair,
    brushRoundness,
    brushAngle,
    brushTexture,
  ]);

  // Handle native pointer events for DOM cursors (zero-lag update)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleNativePointerMove = (e: PointerEvent) => {
      // Always track mouse position, even when DOM cursor is not shown
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };

      // Check if hovering over selection (for move cursor)
      checkSelectionHover(e.clientX, e.clientY);

      // Update brush cursor position
      const brushCursor = brushCursorRef.current;
      if (brushCursor) {
        setCursorPosition(brushCursor, e.clientX, e.clientY);
      }

      // Update eyedropper cursor position
      const eyedropperCursor = eyedropperCursorRef.current;
      if (eyedropperCursor) {
        setCursorPosition(eyedropperCursor, e.clientX, e.clientY);
      }
    };

    const handleNativePointerLeave = () => {
      if (brushCursorRef.current) {
        brushCursorRef.current.style.display = 'none';
      }
      if (eyedropperCursorRef.current) {
        eyedropperCursorRef.current.style.display = 'none';
      }
    };

    const handleNativePointerEnter = (e: PointerEvent) => {
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };

      const brushCursor = brushCursorRef.current;
      if (brushCursor) {
        brushCursor.style.display = 'block';
        setCursorPosition(brushCursor, e.clientX, e.clientY);
      }

      const eyedropperCursor = eyedropperCursorRef.current;
      if (eyedropperCursor) {
        eyedropperCursor.style.display = 'block';
        setCursorPosition(eyedropperCursor, e.clientX, e.clientY);
      }
    };

    container.addEventListener('pointermove', handleNativePointerMove, { passive: true });
    container.addEventListener('pointerleave', handleNativePointerLeave);
    container.addEventListener('pointerenter', handleNativePointerEnter);

    return () => {
      container.removeEventListener('pointermove', handleNativePointerMove);
      container.removeEventListener('pointerleave', handleNativePointerLeave);
      container.removeEventListener('pointerenter', handleNativePointerEnter);
    };
  }, [containerRef, brushCursorRef, eyedropperCursorRef, checkSelectionHover]);

  const showDomCursor = isBrushTool && !isInteracting && !shouldUseHardwareCursor;

  // Show DOM eyedropper cursor when eyedropper tool is active
  // This is needed because Windows overrides CSS cursor when Alt key is held
  const showEyedropperDomCursor = currentTool === 'eyedropper' && !isInteracting;

  // Initialize DOM cursor position when it becomes visible
  // Handles: brush size change via keyboard, Alt key switching to eyedropper
  useEffect(() => {
    const lastPos = lastMousePosRef.current;
    if (!lastPos) return;

    if (showDomCursor && brushCursorRef.current) {
      setCursorPosition(brushCursorRef.current, lastPos.x, lastPos.y);
    }
    if (showEyedropperDomCursor && eyedropperCursorRef.current) {
      setCursorPosition(eyedropperCursorRef.current, lastPos.x, lastPos.y);
    }
  }, [showDomCursor, showEyedropperDomCursor, brushCursorRef, eyedropperCursorRef]);

  let cursorStyle = TOOL_CURSORS[currentTool];
  if (isInteracting) {
    cursorStyle = 'grab';
  } else if (isSelectionTool && isOverSelection && !isCreatingSelection) {
    // Show move cursor when hovering over existing selection
    cursorStyle = SELECTION_MOVE_CURSOR;
  } else if (showEyedropperDomCursor) {
    // Use DOM cursor for eyedropper, hide system cursor
    cursorStyle = 'none';
  } else if (shouldUseHardwareCursor) {
    cursorStyle = hardwareCursorStyle || 'none';
  } else if (showDomCursor) {
    cursorStyle = 'none';
  } else if (showCrosshair && isBrushTool) {
    cursorStyle = 'crosshair';
  }

  return { cursorStyle, showDomCursor, showEyedropperDomCursor };
}

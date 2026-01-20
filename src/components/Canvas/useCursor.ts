import { useEffect, useMemo, useRef } from 'react';
import { ToolType } from '@/stores/tool';

/** Cursor style for each tool type */
const TOOL_CURSORS: Record<ToolType, string> = {
  brush: 'none',
  eraser: 'none',
  eyedropper: 'crosshair',
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
  /** Brush roundness (1-100, 100 = perfect circle) */
  brushRoundness?: number;
  /** Brush angle in degrees (0-360) */
  brushAngle?: number;
  /** Texture cursor data (for ABR brushes) */
  brushTexture?: BrushCursorTexture | null;
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
  brushRoundness = 100,
  brushAngle = 0,
  brushTexture,
}: UseCursorProps) {
  // Track last known mouse position for initializing DOM cursor
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null);

  // Calculate actual pixel size of brush on screen
  const screenBrushSize = currentSize * scale;

  // Determine if we should use hardware cursor (SVG)
  // Q2 Optimization: Windows limits cursor size to ~128x128px
  // Increased threshold from 64px to 128px for better brush tracking with larger brushes
  // Note: If browser silently falls back to software rendering above 128px, this is acceptable
  const shouldUseHardwareCursor =
    (currentTool === 'brush' || currentTool === 'eraser') &&
    screenBrushSize <= 128 &&
    !spacePressed &&
    !isPanning;

  // Should use hardware cursor for eyedropper
  const shouldUseEyedropperCursor = currentTool === 'eyedropper' && !spacePressed && !isPanning;

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
    return `url("${cursorUrl}") ${center} ${center}, crosshair`;
  }, [
    shouldUseHardwareCursor,
    screenBrushSize,
    showCrosshair,
    brushRoundness,
    brushAngle,
    brushTexture,
  ]);

  // Generate eyedropper cursor SVG
  const eyedropperCursorStyle = useMemo(() => {
    if (!shouldUseEyedropperCursor) {
      return '';
    }

    const size = 24;
    // Lucide Pipette icon path
    const svg = `
      <svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none">
        <path d="m2 22 1-1h3l9-9" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="m2 22 1-1h3l9-9" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M3 21v-3l9-9" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M3 21v-3l9-9" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" fill="white" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;

    const cursorUrl = `data:image/svg+xml;base64,${btoa(svg)}`;
    // Hotspot at the pipette tip (bottom-left corner)
    return `url("${cursorUrl}") 2 22, crosshair`;
  }, [shouldUseEyedropperCursor]);

  // Handle native pointer events for DOM cursor (zero-lag update)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleNativePointerMove = (e: PointerEvent) => {
      // Always track mouse position, even when DOM cursor is not shown
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };

      const cursor = brushCursorRef.current;
      if (cursor) {
        setCursorPosition(cursor, e.clientX, e.clientY);
      }
    };

    const handleNativePointerLeave = () => {
      if (brushCursorRef.current) {
        brushCursorRef.current.style.display = 'none';
      }
    };

    const handleNativePointerEnter = (e: PointerEvent) => {
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };

      const cursor = brushCursorRef.current;
      if (cursor) {
        cursor.style.display = 'block';
        setCursorPosition(cursor, e.clientX, e.clientY);
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
  }, [containerRef, brushCursorRef]);

  // Determine if DOM brush cursor should be shown (fallback)
  const showDomCursor =
    (currentTool === 'brush' || currentTool === 'eraser') &&
    !spacePressed &&
    !isPanning &&
    !shouldUseHardwareCursor;

  // Initialize DOM cursor position when it becomes visible
  // This handles the case when brush size changes via keyboard (no pointer event)
  useEffect(() => {
    const cursor = brushCursorRef.current;
    const lastPos = lastMousePosRef.current;

    if (showDomCursor && cursor && lastPos) {
      setCursorPosition(cursor, lastPos.x, lastPos.y);
    }
  }, [showDomCursor, brushCursorRef]);

  // Determine final cursor style string
  let cursorStyle = TOOL_CURSORS[currentTool];
  if (spacePressed || isPanning) {
    cursorStyle = 'grab';
  } else if (shouldUseEyedropperCursor && eyedropperCursorStyle) {
    cursorStyle = eyedropperCursorStyle;
  } else if (shouldUseHardwareCursor && hardwareCursorStyle) {
    cursorStyle = hardwareCursorStyle;
  } else if (showDomCursor) {
    // When using DOM cursor, hide system cursor completely
    cursorStyle = 'none';
  } else if (showCrosshair && (currentTool === 'brush' || currentTool === 'eraser')) {
    cursorStyle = 'crosshair';
  }

  return { cursorStyle, showDomCursor };
}

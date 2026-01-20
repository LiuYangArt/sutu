import { useEffect, useMemo } from 'react';
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

/**
 * Generate SVG content for texture brush cursor outline.
 * Shared by both hardware cursor and DOM cursor.
 */
export function generateTextureOutlineSvg(
  cursorPath: string,
  size: number,
  scaleY: number,
  angle: number,
  stroke: StrokeStyle = DEFAULT_STROKE
): string {
  const strokeWidth = Math.max(1.5 / size, 0.02);
  return `
    <g transform="rotate(${angle}) scale(${size}, ${size * scaleY})">
      <path d="${cursorPath}" fill="none" stroke="${stroke.outer.color}" stroke-width="${strokeWidth * stroke.outer.width}"/>
      <path d="${cursorPath}" fill="none" stroke="${stroke.inner.color}" stroke-width="${strokeWidth * stroke.inner.width}"/>
    </g>
  `;
}

/**
 * Generate SVG content for ellipse brush cursor.
 */
export function generateEllipseOutlineSvg(
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
    let crosshairContent = '';
    if (showCrosshair) {
      const crossSize = 8;
      crosshairContent = `
        <line x1="${center - crossSize}" y1="${center}" x2="${center + crossSize}" y2="${center}" stroke="black" stroke-width="2"/>
        <line x1="${center - crossSize}" y1="${center}" x2="${center + crossSize}" y2="${center}" stroke="white" stroke-width="1"/>
        <line x1="${center}" y1="${center - crossSize}" x2="${center}" y2="${center + crossSize}" stroke="black" stroke-width="2"/>
        <line x1="${center}" y1="${center - crossSize}" x2="${center}" y2="${center + crossSize}" stroke="white" stroke-width="1"/>
      `;
    }

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
      const cursor = brushCursorRef.current;
      if (cursor) {
        cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
      }
    };

    const handleNativePointerLeave = () => {
      if (brushCursorRef.current) {
        brushCursorRef.current.style.display = 'none';
      }
    };

    const handleNativePointerEnter = (e: PointerEvent) => {
      const cursor = brushCursorRef.current;
      if (cursor) {
        cursor.style.display = 'block';
        cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
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

  // Determine final cursor style string
  let cursorStyle = TOOL_CURSORS[currentTool];
  if (spacePressed || isPanning) {
    cursorStyle = 'grab';
  } else if (shouldUseEyedropperCursor && eyedropperCursorStyle) {
    cursorStyle = eyedropperCursorStyle;
  } else if (shouldUseHardwareCursor && hardwareCursorStyle) {
    cursorStyle = hardwareCursorStyle;
  } else if (showCrosshair && (currentTool === 'brush' || currentTool === 'eraser')) {
    cursorStyle = 'crosshair';
  }

  // Determine if DOM brush cursor should be shown (fallback)
  const showDomCursor =
    (currentTool === 'brush' || currentTool === 'eraser') &&
    !spacePressed &&
    !isPanning &&
    !shouldUseHardwareCursor;

  return { cursorStyle, showDomCursor };
}

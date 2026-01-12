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
};

interface UseCursorProps {
  currentTool: ToolType;
  currentSize: number;
  scale: number;
  showCrosshair: boolean;
  spacePressed: boolean;
  isPanning: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
  brushCursorRef: React.RefObject<HTMLDivElement>;
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
}: UseCursorProps) {
  // Calculate actual pixel size of brush on screen
  const screenBrushSize = currentSize * scale;

  // Determine if we should use hardware cursor (SVG)
  // Windows usually limits cursor size to ~128px, using 64px as safe threshold
  const shouldUseHardwareCursor =
    (currentTool === 'brush' || currentTool === 'eraser') &&
    screenBrushSize <= 64 &&
    !spacePressed &&
    !isPanning;

  // Generate SVG cursor URL synchronously using useMemo
  const hardwareCursorStyle = useMemo(() => {
    if (!shouldUseHardwareCursor) {
      return '';
    }

    const r = screenBrushSize / 2;
    // Add padding to avoid clipping
    const canvasSize = Math.ceil(screenBrushSize + 4);
    const center = canvasSize / 2;

    // Generate SVG content
    let svgContent = `
      <circle cx="${center}" cy="${center}" r="${r}" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="1.5"/>
      <circle cx="${center}" cy="${center}" r="${r}" fill="none" stroke="rgba(0,0,0,0.8)" stroke-width="1"/>
    `;

    if (showCrosshair) {
      const crossSize = 8;
      svgContent += `
        <line x1="${center - crossSize}" y1="${center}" x2="${center + crossSize}" y2="${center}" stroke="black" stroke-width="2"/>
        <line x1="${center - crossSize}" y1="${center}" x2="${center + crossSize}" y2="${center}" stroke="white" stroke-width="1"/>
        <line x1="${center}" y1="${center - crossSize}" x2="${center}" y2="${center + crossSize}" stroke="black" stroke-width="2"/>
        <line x1="${center}" y1="${center - crossSize}" x2="${center}" y2="${center + crossSize}" stroke="white" stroke-width="1"/>
      `;
    }

    const svg = `
      <svg width="${canvasSize}" height="${canvasSize}" viewBox="0 0 ${canvasSize} ${canvasSize}" xmlns="http://www.w3.org/2000/svg">
        ${svgContent}
      </svg>
    `;

    const cursorUrl = `data:image/svg+xml;base64,${btoa(svg)}`;
    return `url("${cursorUrl}") ${center} ${center}, crosshair`;
  }, [shouldUseHardwareCursor, screenBrushSize, showCrosshair]);

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

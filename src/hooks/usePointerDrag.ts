import { useRef, useCallback } from 'react';

export type PointerOutput = { x: number; y: number; width: number; height: number };

/**
 * Hook to handle pointer drag comparisons for custom sliders/pickers
 * @param onChange Callback with position details
 * @param options Configuration options
 */
export function usePointerDrag(
  onChange: (output: PointerOutput) => void,
  options?: {
    onDragStart?: () => void;
    onDragEnd?: () => void;
    hideCursor?: boolean;
  }
): {
  containerRef: React.RefObject<HTMLDivElement>;
  events: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerLeave: (e: React.PointerEvent) => void;
  };
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const rectRef = useRef<DOMRect | null>(null);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current || !containerRef.current) return;

      // Use cached rect if available, otherwise get fresh (fallback)
      const rect = rectRef.current || containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      onChange({ x, y, width: rect.width, height: rect.height });
    },
    [onChange]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Prevent defaults to avoid text selection/scrolling
      e.preventDefault();

      if (!containerRef.current) return;

      isDragging.current = true;
      containerRef.current.setPointerCapture(e.pointerId);

      // Cache the rect to avoid reflows during drag
      rectRef.current = containerRef.current.getBoundingClientRect();

      if (options?.hideCursor) {
        containerRef.current.style.cursor = 'none';
      }

      options?.onDragStart?.();

      // Trigger initial move on down
      handlePointerMove(e);
    },
    [handlePointerMove, options]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (isDragging.current && containerRef.current) {
        isDragging.current = false;
        containerRef.current.releasePointerCapture(e.pointerId);
        rectRef.current = null;

        if (options?.hideCursor) {
          containerRef.current.style.cursor = '';
        }

        options?.onDragEnd?.();
      }
    },
    [options]
  );

  return {
    containerRef,
    events: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerLeave: handlePointerUp,
    },
  };
}

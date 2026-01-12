import { useRef, useCallback } from 'react';

type PointerOutput = { x: number; y: number; width: number; height: number };

/**
 * Hook to handle pointer drag comparisons for custom sliders/pickers
 * @param onChange Callback with position details
 */
export function usePointerDrag(onChange: (output: PointerOutput) => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
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

      // Trigger initial move on down
      handlePointerMove(e);
    },
    [handlePointerMove]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (isDragging.current && containerRef.current) {
      isDragging.current = false;
      containerRef.current.releasePointerCapture(e.pointerId);
    }
  }, []);

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

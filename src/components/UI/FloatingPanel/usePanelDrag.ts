import { useRef, useCallback } from 'react';

interface DragOptions {
  onDragStart?: () => void;
  onDrag: (deltaX: number, deltaY: number) => void;
  onDragEnd?: () => void;
}

export function usePanelDrag({ onDragStart, onDrag, onDragEnd }: DragOptions) {
  const isDragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const finishDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current) return;

      isDragging.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
      onDragEnd?.();
    },
    [onDragEnd]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation(); // Prevent triggering other drags
      e.preventDefault();

      // Only allow left mouse button generic drag
      if (e.button !== 0) return;

      isDragging.current = true;
      lastPos.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);

      onDragStart?.();
    },
    [onDragStart]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current) return;
      e.preventDefault();

      const deltaX = e.clientX - lastPos.current.x;
      const deltaY = e.clientY - lastPos.current.y;

      // Update last pos
      lastPos.current = { x: e.clientX, y: e.clientY };

      onDrag(deltaX, deltaY);
    },
    [onDrag]
  );

  return {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: finishDrag,
    onPointerCancel: finishDrag,
  };
}

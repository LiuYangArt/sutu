import { useCallback } from 'react';
import { usePanelDrag } from './usePanelDrag';
import { PanelGeometry } from '../../../stores/panel';

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface ResizeOptions {
  direction: ResizeDirection;
  onResize: (geometryDelta: Partial<PanelGeometry>) => void;
  minWidth?: number;
  minHeight?: number;
}

export function usePanelResize({ direction, onResize }: ResizeOptions) {
  const handleDrag = useCallback(
    (dx: number, dy: number) => {
      const delta: Partial<PanelGeometry> = {};

      if (direction.includes('e')) {
        delta.width = dx;
      }
      if (direction.includes('w')) {
        delta.x = dx;
        delta.width = -dx;
      }
      if (direction.includes('s')) {
        delta.height = dy;
      }
      if (direction.includes('n')) {
        delta.y = dy;
        delta.height = -dy;
      }

      onResize(delta);
    },
    [direction, onResize]
  );

  return usePanelDrag({
    onDrag: handleDrag,
  });
}

import { useCallback } from 'react';
import { usePanelDrag } from './usePanelDrag';
import type { PanelGeometry } from '../../../stores/panel';

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface ResizeOptions {
  direction: ResizeDirection;
  onResize: (geometryDelta: Partial<PanelGeometry>) => void;
}

export function usePanelResize({ direction, onResize }: ResizeOptions) {
  const fromEast = direction.includes('e');
  const fromWest = direction.includes('w');
  const fromSouth = direction.includes('s');
  const fromNorth = direction.includes('n');

  const handleDrag = useCallback(
    (dx: number, dy: number) => {
      const delta: Partial<PanelGeometry> = {};

      if (fromEast) {
        delta.width = dx;
      }
      if (fromWest) {
        delta.x = dx;
        delta.width = -dx;
      }
      if (fromSouth) {
        delta.height = dy;
      }
      if (fromNorth) {
        delta.y = dy;
        delta.height = -dy;
      }

      onResize(delta);
    },
    [fromEast, fromWest, fromSouth, fromNorth, onResize]
  );

  return usePanelDrag({
    onDrag: handleDrag,
  });
}

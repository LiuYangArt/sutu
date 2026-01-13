import { PanelAlignment, PanelGeometry } from '../../../stores/panel';

/**
 * Calculates the absolute position from an alignment configuration.
 * used when converting an anchored panel to a free-floating one.
 */
export function getAbsolutePositionFromAlignment(
  alignment: PanelAlignment,
  panel: PanelGeometry,
  windowSize: { width: number; height: number }
): { x: number; y: number } {
  const { horizontal, vertical, offsetX, offsetY } = alignment;
  let x = panel.x;
  let y = panel.y;

  if (horizontal === 'left') {
    x = offsetX;
  } else {
    x = windowSize.width - offsetX - panel.width;
  }

  if (vertical === 'top') {
    y = offsetY;
  } else {
    y = windowSize.height - offsetY - panel.height;
  }

  return { x, y };
}

/**
 * Calculates the new alignment offsets when an anchored panel is resized.
 * This ensures that if a panel is anchored to the Right, resizing it from the Left
 * doesn't cause it to drift visually (i.e. it updates the anchor offset).
 */
export function calculateNewAlignment(
  currentAlignment: PanelAlignment,
  newGeometry: PanelGeometry,
  delta: Partial<PanelGeometry>,
  windowSize: { width: number; height: number }
): PanelAlignment | null {
  const { horizontal, vertical, offsetX, offsetY } = currentAlignment;
  let newOffsetX = offsetX;
  let newOffsetY = offsetY;
  let changed = false;

  // X-axis adjustments
  if (delta.width !== undefined || delta.x !== undefined) {
    if (horizontal === 'right') {
      // If anchored RIGHT, resizing from the LEFT changes x and width.
      // We prioritize keeping the visual right edge stable relative to window right.
      const newRight = newGeometry.x + newGeometry.width;
      newOffsetX = windowSize.width - newRight;
      changed = true;
    } else if (horizontal === 'left') {
      // If anchored LEFT, offset is just x
      newOffsetX = newGeometry.x;
      changed = true;
    }
  }

  // Y-axis adjustments
  if (delta.height !== undefined || delta.y !== undefined) {
    if (vertical === 'bottom') {
      const newBottom = newGeometry.y + newGeometry.height;
      newOffsetY = windowSize.height - newBottom;
      changed = true;
    } else if (vertical === 'top') {
      newOffsetY = newGeometry.y;
      changed = true;
    }
  }

  if (!changed) return null;

  return {
    horizontal,
    vertical,
    offsetX: newOffsetX,
    offsetY: newOffsetY,
  };
}

/**
 * Calculates the nearest anchor alignment based on the panel's current position.
 */
export function calculateSnapAlignment(
  panel: PanelGeometry,
  windowSize: { width: number; height: number }
): PanelAlignment {
  const centerX = panel.x + panel.width / 2;
  const centerY = panel.y + panel.height / 2;

  const horizontal: 'left' | 'right' = centerX < windowSize.width / 2 ? 'left' : 'right';
  const offsetX = horizontal === 'left' ? panel.x : windowSize.width - (panel.x + panel.width);

  const vertical: 'top' | 'bottom' = centerY < windowSize.height / 2 ? 'top' : 'bottom';
  const offsetY = vertical === 'top' ? panel.y : windowSize.height - (panel.y + panel.height);

  return {
    horizontal,
    vertical,
    offsetX,
    offsetY,
  };
}

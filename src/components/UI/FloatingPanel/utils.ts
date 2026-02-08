import type { PanelAlignment, PanelGeometry } from '../../../stores/panel';

interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Calculates the absolute position from an alignment configuration.
 * used when converting an anchored panel to a free-floating one.
 */
export function getAbsolutePositionFromAlignment(
  alignment: PanelAlignment,
  panel: PanelGeometry,
  windowSize: ViewportSize
): { x: number; y: number } {
  const { horizontal, vertical, offsetX, offsetY } = alignment;
  const x = horizontal === 'left' ? offsetX : windowSize.width - offsetX - panel.width;
  const y = vertical === 'top' ? offsetY : windowSize.height - offsetY - panel.height;

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
  windowSize: ViewportSize
): PanelAlignment | null {
  const { horizontal, vertical, offsetX, offsetY } = currentAlignment;
  const hasHorizontalDelta = delta.width !== undefined || delta.x !== undefined;
  const hasVerticalDelta = delta.height !== undefined || delta.y !== undefined;
  if (!hasHorizontalDelta && !hasVerticalDelta) return null;

  const newOffsetX = hasHorizontalDelta
    ? horizontal === 'left'
      ? newGeometry.x
      : windowSize.width - (newGeometry.x + newGeometry.width)
    : offsetX;
  const newOffsetY = hasVerticalDelta
    ? vertical === 'top'
      ? newGeometry.y
      : windowSize.height - (newGeometry.y + newGeometry.height)
    : offsetY;

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
  windowSize: ViewportSize
): PanelAlignment {
  const centerX = panel.x + panel.width / 2;
  const centerY = panel.y + panel.height / 2;
  const horizontal = centerX < windowSize.width / 2 ? 'left' : 'right';
  const vertical = centerY < windowSize.height / 2 ? 'top' : 'bottom';

  const offsetX = horizontal === 'left' ? panel.x : windowSize.width - (panel.x + panel.width);
  const offsetY = vertical === 'top' ? panel.y : windowSize.height - (panel.y + panel.height);

  return {
    horizontal,
    vertical,
    offsetX,
    offsetY,
  };
}

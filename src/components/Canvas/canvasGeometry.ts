interface CanvasClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function normalizePositiveNumber(value: number, fallback: number = 1): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Convert client-space coordinates to canvas logical pixel coordinates.
 * Works with any CSS transform/scale by using the actual rendered rect size.
 */
export function clientToCanvasPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  rect?: CanvasClientRect
): { x: number; y: number } {
  const resolvedRect = rect ?? canvas.getBoundingClientRect();
  const rectWidth = normalizePositiveNumber(resolvedRect.width, Math.max(1, canvas.width));
  const rectHeight = normalizePositiveNumber(resolvedRect.height, Math.max(1, canvas.height));
  const scaleX = canvas.width / rectWidth;
  const scaleY = canvas.height / rectHeight;

  return {
    x: (clientX - resolvedRect.left) * scaleX,
    y: (clientY - resolvedRect.top) * scaleY,
  };
}

export function getDisplayScale(scale: number, devicePixelRatio: number): number {
  const safeScale = normalizePositiveNumber(scale);
  const safeDpr = normalizePositiveNumber(devicePixelRatio);
  return safeScale / safeDpr;
}

export function getSafeDevicePixelRatio(viewport?: Pick<Window, 'devicePixelRatio'>): number {
  if (!viewport) return 1;
  return normalizePositiveNumber(viewport.devicePixelRatio);
}

interface CanvasClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
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
  const rectWidth = resolvedRect.width > 0 ? resolvedRect.width : Math.max(1, canvas.width);
  const rectHeight = resolvedRect.height > 0 ? resolvedRect.height : Math.max(1, canvas.height);
  const scaleX = canvas.width / rectWidth;
  const scaleY = canvas.height / rectHeight;

  return {
    x: (clientX - resolvedRect.left) * scaleX,
    y: (clientY - resolvedRect.top) * scaleY,
  };
}

export function getDisplayScale(scale: number, devicePixelRatio: number): number {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const safeDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return safeScale / safeDpr;
}

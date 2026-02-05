const MAX_THUMB_HEIGHT = 32;
const MIN_THUMB_WIDTH = 32;
const MAX_THUMB_WIDTH = 80;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getLayerThumbnailSize(
  docWidth: number,
  docHeight: number
): { width: number; height: number } {
  const safeWidth = docWidth > 0 ? docWidth : 1;
  const safeHeight = docHeight > 0 ? docHeight : 1;
  const aspectRatio = safeWidth / safeHeight;
  const height = MAX_THUMB_HEIGHT;
  const width = clamp(Math.round(height * aspectRatio), MIN_THUMB_WIDTH, MAX_THUMB_WIDTH);
  return { width, height };
}

export function renderLayerThumbnail(
  layerCanvas: HTMLCanvasElement,
  docWidth: number,
  docHeight: number
): string | undefined {
  const { width, height } = getLayerThumbnailSize(docWidth, docHeight);

  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = width;
  thumbCanvas.height = height;

  const ctx = thumbCanvas.getContext('2d');
  if (!ctx) return undefined;

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(layerCanvas, 0, 0, width, height);

  return thumbCanvas.toDataURL('image/png');
}

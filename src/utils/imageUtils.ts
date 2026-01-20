/**
 * Image utility functions for brush texture processing
 */

/**
 * Decode base64 PNG to ImageData
 * Uses OffscreenCanvas for performance when available
 */
export async function decodeBase64ToImageData(
  base64: string,
  width: number,
  height: number
): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(width, height)
          : document.createElement('canvas');

      if (!(canvas instanceof OffscreenCanvas)) {
        canvas.width = width;
        canvas.height = height;
      }

      const ctx = canvas.getContext('2d') as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D;
      if (!ctx) {
        reject(new Error('Failed to create canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);
      resolve(imageData);
    };
    img.onerror = () => reject(new Error('Failed to load texture image'));
    img.src = `data:image/png;base64,${base64}`;
  });
}

/**
 * Synchronously decode base64 PNG (blocking, for immediate use)
 * Returns null if image is not yet loaded
 */
export function decodeBase64ToImageDataSync(
  base64: string,
  width: number,
  height: number
): ImageData | null {
  try {
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;

    // If image is not yet loaded, we can't decode synchronously
    if (!img.complete) {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(img, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } catch {
    return null;
  }
}

import { decompressLz4PrependSize } from '@/utils/lz4';

/**
 * Loads a brush texture via the project:// protocol (mapped to http://project.localhost)
 * Decompresses LZ4 Gray8 data and converts to RGBA ImageData
 *
 * @param textureId - The ID of the brush texture to load
 * @param fallbackWidth - Width to use if headers don't provide it
 * @param fallbackHeight - Height to use if headers don't provide it
 */
export async function loadBrushTexture(
  textureId: string,
  fallbackWidth: number = 0,
  fallbackHeight: number = 0
): Promise<ImageData | null> {
  try {
    // Use http://project.localhost/ format for Windows compatibility
    // See: docs/postmortem/2026-01-22-canvas-taint-crossorigin.md
    const response = await fetch(`http://project.localhost/brush/${textureId}`);

    if (!response.ok) {
      return null;
    }

    const respWidth = parseInt(response.headers.get('X-Image-Width') || '0', 10);
    const respHeight = parseInt(response.headers.get('X-Image-Height') || '0', 10);

    // Use response dimensions if available, otherwise use provided dimensions
    const width = respWidth > 0 ? respWidth : fallbackWidth;
    const height = respHeight > 0 ? respHeight : fallbackHeight;

    if (width === 0 || height === 0) {
      console.warn(`[BrushLoader] Invalid dimensions for texture ${textureId}`);
      return null;
    }

    const compressed = new Uint8Array(await response.arrayBuffer());
    const data = decompressLz4PrependSize(compressed);

    // Check data format based on size
    const expectedSizeRGBA = width * height * 4;
    const expectedSizeGray8 = width * height;

    if (data.length === expectedSizeRGBA) {
      // Already RGBA (e.g. ABR Patterns)
      return new ImageData(new Uint8ClampedArray(data), width, height);
    } else if (data.length === expectedSizeGray8) {
      // Gray8 -> RGBA conversion (e.g. Brushes)
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i++) {
        const v = data[i]!;
        const idx = i * 4;
        rgba[idx] = v;
        rgba[idx + 1] = v;
        rgba[idx + 2] = v;
        rgba[idx + 3] = 255;
      }
      return new ImageData(rgba, width, height);
    } else {
      console.warn(
        `[BrushLoader] Unexpected data size for ${textureId}: ${data.length} (Expected ${expectedSizeGray8} or ${expectedSizeRGBA})`
      );
      return null;
    }
  } catch (err) {
    console.warn(`[BrushLoader] Protocol load failed for ${textureId}:`, err);
    return null;
  }
}

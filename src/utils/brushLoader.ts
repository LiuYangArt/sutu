import { decompressLz4PrependSize } from '@/utils/lz4';

const TEXTURE_CACHE_LIMIT = 128;
const textureCache = new Map<string, ImageData>();
const inFlightLoads = new Map<string, Promise<ImageData | null>>();

interface BrushTextureCandidate {
  id: string;
  width?: number | null;
  height?: number | null;
}

function touchTextureCache(textureId: string, imageData: ImageData): void {
  if (textureCache.has(textureId)) {
    textureCache.delete(textureId);
  }
  textureCache.set(textureId, imageData);

  if (textureCache.size <= TEXTURE_CACHE_LIMIT) {
    return;
  }

  const oldestKey = textureCache.keys().next().value as string | undefined;
  if (oldestKey) {
    textureCache.delete(oldestKey);
  }
}

function readTextureCache(textureId: string): ImageData | null {
  const cached = textureCache.get(textureId);
  if (!cached) {
    return null;
  }
  touchTextureCache(textureId, cached);
  return cached;
}

export function getCachedBrushTexture(textureId: string): ImageData | null {
  return readTextureCache(textureId);
}

function buildImageDataFromGray(gray: Uint8Array, width: number, height: number): ImageData {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i]!;
    const idx = i * 4;
    rgba[idx] = v;
    rgba[idx + 1] = v;
    rgba[idx + 2] = v;
    rgba[idx + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

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
  const cached = readTextureCache(textureId);
  if (cached) {
    return cached;
  }

  const existingLoad = inFlightLoads.get(textureId);
  if (existingLoad) {
    return existingLoad;
  }

  const loadPromise = (async () => {
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
      const gray = decompressLz4PrependSize(compressed);

      const imageData = buildImageDataFromGray(gray, width, height);
      touchTextureCache(textureId, imageData);
      return imageData;
    } catch (err) {
      console.warn(`[BrushLoader] Protocol load failed for ${textureId}:`, err);
      return null;
    } finally {
      inFlightLoads.delete(textureId);
    }
  })();

  inFlightLoads.set(textureId, loadPromise);
  return loadPromise;
}

function getIdleScheduler(): ((cb: () => void) => void) | null {
  if (typeof window === 'undefined') {
    return null;
  }

  type IdleWindow = Window &
    typeof globalThis & {
      requestIdleCallback?: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number;
    };

  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === 'function') {
    return (cb: () => void) => {
      idleWindow.requestIdleCallback?.(() => cb(), { timeout: 300 });
    };
  }

  return (cb: () => void) => {
    window.setTimeout(cb, 16);
  };
}

export function prewarmBrushTextures(
  candidates: BrushTextureCandidate[],
  maxCount: number = 12
): void {
  if (maxCount <= 0 || candidates.length === 0) {
    return;
  }

  const unique: BrushTextureCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const id = candidate.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    unique.push(candidate);
    if (unique.length >= maxCount) {
      break;
    }
  }

  if (unique.length === 0) {
    return;
  }

  const schedule = getIdleScheduler();
  if (!schedule) {
    return;
  }

  schedule(() => {
    void (async () => {
      for (const candidate of unique) {
        const width = candidate.width ?? 0;
        const height = candidate.height ?? 0;
        await loadBrushTexture(candidate.id, width, height);
      }
    })();
  });
}

export function __resetBrushTextureCacheForTests(): void {
  textureCache.clear();
  inFlightLoads.clear();
}

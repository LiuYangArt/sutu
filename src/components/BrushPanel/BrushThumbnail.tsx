/**
 * BrushThumbnail - Canvas-based brush texture renderer
 *
 * Fetches brush texture via the project protocol URL,
 * decompresses LZ4 Gray8 data, and renders to canvas.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getCachedBrushTexture, loadBrushTexture } from '@/utils/brushLoader';

interface BrushThumbnailProps {
  /** Brush ID for fetching texture */
  brushId: string;
  /** Display size in pixels */
  size?: number;
  /** CSS class name */
  className?: string;
  /** Alt text for accessibility */
  alt?: string;
}

const THUMBNAIL_CACHE_LIMIT = 512;
const renderedThumbnailCache = new Map<string, ImageData>();

function touchRenderedThumbnailCache(cacheKey: string, imageData: ImageData): void {
  if (renderedThumbnailCache.has(cacheKey)) {
    renderedThumbnailCache.delete(cacheKey);
  }
  renderedThumbnailCache.set(cacheKey, imageData);

  if (renderedThumbnailCache.size <= THUMBNAIL_CACHE_LIMIT) {
    return;
  }

  const oldestKey = renderedThumbnailCache.keys().next().value as string | undefined;
  if (oldestKey) {
    renderedThumbnailCache.delete(oldestKey);
  }
}

function readRenderedThumbnailCache(cacheKey: string): ImageData | null {
  const cached = renderedThumbnailCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  touchRenderedThumbnailCache(cacheKey, cached);
  return cached;
}

function drawRenderedThumbnail(
  canvas: HTMLCanvasElement,
  size: number,
  rendered: ImageData
): boolean {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return false;
  }
  ctx.clearRect(0, 0, size, size);
  ctx.putImageData(rendered, 0, 0);
  return true;
}

function renderSourceTextureToCanvas(
  canvas: HTMLCanvasElement,
  size: number,
  imageData: ImageData
): ImageData | null {
  // Create offscreen canvas at full resolution, then scale
  const offscreen = document.createElement('canvas');
  offscreen.width = imageData.width;
  offscreen.height = imageData.height;
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) return null;

  // Convert grayscale texture to white-on-transparent mask for thumbnail preview.
  // This aligns sampled tips with procedural tip appearance in the preset grid.
  const src = imageData.data;
  const maskRgba = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const gray = src[i] ?? 0;
    maskRgba[i] = 255;
    maskRgba[i + 1] = 255;
    maskRgba[i + 2] = 255;
    maskRgba[i + 3] = gray;
  }
  offCtx.putImageData(new ImageData(maskRgba, imageData.width, imageData.height), 0, 0);

  // Scale to display size with aspect-ratio preserving contain fit.
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, size, size);

  const srcW = imageData.width;
  const srcH = imageData.height;
  const scale = Math.min(size / srcW, size / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const drawX = (size - drawW) / 2;
  const drawY = (size - drawH) / 2;
  ctx.drawImage(offscreen, drawX, drawY, drawW, drawH);

  return ctx.getImageData(0, 0, size, size);
}

function drawFromRenderedThumbnailCache(
  canvas: HTMLCanvasElement,
  size: number,
  cacheKey: string
): boolean {
  const cachedRendered = readRenderedThumbnailCache(cacheKey);
  if (!cachedRendered) {
    return false;
  }
  return drawRenderedThumbnail(canvas, size, cachedRendered);
}

function drawFromTextureCache(
  canvas: HTMLCanvasElement,
  size: number,
  brushId: string,
  cacheKey: string
): boolean {
  const cachedTexture = getCachedBrushTexture(brushId);
  if (!cachedTexture) {
    return false;
  }

  const rendered = renderSourceTextureToCanvas(canvas, size, cachedTexture);
  if (!rendered) {
    return false;
  }
  touchRenderedThumbnailCache(cacheKey, rendered);
  return true;
}

export function BrushThumbnail({
  brushId,
  size = 48,
  className = '',
  alt = 'Brush texture',
}: BrushThumbnailProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cacheKey = `${brushId}@${size}`;
  const [isInView, setIsInView] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return true;
    }

    return typeof window.IntersectionObserver === 'undefined';
  });
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  useLayoutEffect(() => {
    if (!isInView) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const hitCache =
      drawFromRenderedThumbnailCache(canvas, size, cacheKey) ||
      drawFromTextureCache(canvas, size, brushId, cacheKey);
    if (!hitCache) {
      return;
    }

    setHasError(false);
    setIsLoading(false);
  }, [brushId, cacheKey, isInView, size]);

  useEffect(() => {
    if (isInView) {
      return;
    }

    const canvas = canvasRef.current;
    if (
      !canvas ||
      typeof window === 'undefined' ||
      typeof window.IntersectionObserver === 'undefined'
    ) {
      setIsInView(true);
      return;
    }

    const observer = new window.IntersectionObserver(
      (entries) => {
        const matched = entries.some(
          (entry) => entry.isIntersecting || entry.intersectionRatio > 0
        );
        if (!matched) {
          return;
        }
        setIsInView(true);
        observer.disconnect();
      },
      {
        root: null,
        rootMargin: '120px',
        threshold: 0.01,
      }
    );

    observer.observe(canvas);

    return () => {
      observer.disconnect();
    };
  }, [isInView]);

  useEffect(() => {
    if (!isInView) {
      return;
    }

    const cachedCanvas = canvasRef.current;
    if (cachedCanvas && drawFromRenderedThumbnailCache(cachedCanvas, size, cacheKey)) {
      setHasError(false);
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    const loadTexture = async () => {
      setIsLoading(true);
      setHasError(false);

      try {
        const imageData = await loadBrushTexture(brushId);

        if (cancelled) return;

        if (!imageData) {
          throw new Error(`Failed to fetch brush: ${brushId}`);
        }

        const canvas = canvasRef.current;
        if (!canvas) return;

        const rendered = renderSourceTextureToCanvas(canvas, size, imageData);
        if (rendered) {
          touchRenderedThumbnailCache(cacheKey, rendered);
        }

        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.warn(`[Brush Thumbnail] Failed to load ${brushId}:`, err);
        setHasError(true);
        setIsLoading(false);
      }
    };

    loadTexture();

    return () => {
      cancelled = true;
    };
  }, [brushId, cacheKey, size, isInView]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className={`brush-thumbnail ${className} ${isLoading ? 'loading' : ''} ${hasError ? 'error' : ''} ${isInView ? '' : 'deferred'}`}
      title={alt}
      style={{
        width: size,
        height: size,
        backgroundColor: hasError ? '#333' : undefined,
      }}
    />
  );
}

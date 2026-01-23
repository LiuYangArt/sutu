/**
 * BrushThumbnail - Canvas-based brush texture renderer
 *
 * Fetches brush texture via project:// protocol (mapped to http://project.localhost/ on Windows),
 * decompresses LZ4 Gray8 data, and renders to canvas.
 */
import { useEffect, useRef, useState } from 'react';
import { loadBrushTexture } from '@/utils/brushLoader';

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

export function BrushThumbnail({
  brushId,
  size = 48,
  className = '',
  alt = 'Brush texture',
}: BrushThumbnailProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
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

        // Create offscreen canvas at full resolution, then scale
        const offscreen = document.createElement('canvas');
        offscreen.width = imageData.width;
        offscreen.height = imageData.height;
        const offCtx = offscreen.getContext('2d');
        if (!offCtx) return;

        offCtx.putImageData(imageData, 0, 0);

        // Scale to display size
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(offscreen, 0, 0, size, size);

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
  }, [brushId, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className={`brush-thumbnail ${className} ${isLoading ? 'loading' : ''} ${hasError ? 'error' : ''}`}
      title={alt}
      style={{
        width: size,
        height: size,
        backgroundColor: hasError ? '#333' : undefined,
      }}
    />
  );
}

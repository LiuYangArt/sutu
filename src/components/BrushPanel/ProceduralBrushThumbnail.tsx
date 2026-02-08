import { useEffect, useRef } from 'react';
import { renderProceduralThumbnail } from './thumbnailUtils';

interface ProceduralBrushThumbnailProps {
  hardness: number;
  roundness: number;
  angle: number;
  size?: number;
  className?: string;
  alt?: string;
}

export function ProceduralBrushThumbnail({
  hardness,
  roundness,
  angle,
  size = 48,
  className = '',
  alt = 'Procedural brush texture',
}: ProceduralBrushThumbnailProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    renderProceduralThumbnail(ctx, size, {
      hardness,
      roundness,
      angle,
    });
  }, [hardness, roundness, angle, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className={`${className} procedural-brush-thumbnail`}
      title={alt}
      style={{ width: size, height: size }}
    />
  );
}

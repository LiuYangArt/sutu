import React, { useEffect, useRef, useState } from 'react';
import { decompressLz4PrependSize } from '@/utils/lz4';

interface LZ4ImageProps {
  src: string | null;
  style?: React.CSSProperties;
  className?: string;
  alt?: string;
}

export function LZ4Image({ src, style, className, alt }: LZ4ImageProps): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!src) return;

    let active = true;
    setError(false);

    const fetchAndRender = async () => {
      try {
        const response = await fetch(src);
        if (!response.ok) {
          throw new Error(`Status ${response.status}`);
        }

        const widthHeader = response.headers.get('X-Image-Width');
        const heightHeader = response.headers.get('X-Image-Height');

        if (!widthHeader || !heightHeader) {
          throw new Error('Missing dimension headers');
        }

        const width = parseInt(widthHeader, 10);
        const height = parseInt(heightHeader, 10);

        const buffer = await response.arrayBuffer();
        if (!active) return;

        const compressed = new Uint8Array(buffer);
        const rgba = decompressLz4PrependSize(compressed);

        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
            ctx.putImageData(imageData, 0, 0);
          }
        }
      } catch (err) {
        console.error('LZ4Image load failed:', src, err);
        if (active) setError(true);
      }
    };

    void fetchAndRender();
    return () => {
      active = false;
    };
  }, [src]);

  if (error) {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-bg-secondary)',
          color: 'var(--color-text-tertiary)',
          fontSize: '10px',
        }}
        title={alt || 'Image Error'}
      >
        !
      </div>
    );
  }

  return <canvas ref={canvasRef} className={className} style={style} title={alt} />;
}

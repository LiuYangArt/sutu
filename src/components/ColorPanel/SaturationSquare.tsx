import { memo, useCallback, useRef } from 'react';
import { usePointerDrag, PointerOutput } from '@/hooks/usePointerDrag';
import './SaturationSquare.css';

interface SaturationSquareProps {
  hsva: { h: number; s: number; v: number; a: number };
  onChange: (newHsva: { h: number; s: number; v: number; a: number }) => void;
}

export const SaturationSquare = memo(function SaturationSquare({
  hsva,
  onChange,
}: SaturationSquareProps) {
  const pointerRef = useRef<HTMLDivElement>(null);
  const hsvaRef = useRef(hsva);
  hsvaRef.current = hsva; // Keep ref in sync with render

  const handleChange = useCallback(
    ({ x, y, width, height }: PointerOutput) => {
      const s = Math.max(0, Math.min((x / width) * 100, 100));
      const v = Math.max(0, Math.min(100 - (y / height) * 100, 100));

      // Direct DOM update for zero latency
      if (pointerRef.current) {
        pointerRef.current.style.left = `${s}%`;
        pointerRef.current.style.top = `${100 - v}%`;
      }

      // Update state
      const current = hsvaRef.current;
      onChange({ ...current, s, v });
    },
    [onChange]
  );

  const { containerRef, events } = usePointerDrag(handleChange, {
    hideCursor: true,
  });

  // Background color for the square (Base Hue)
  const bgColor = `hsl(${hsva.h}, 100%, 50%)`;

  return (
    <div
      className="saturation-square"
      ref={containerRef}
      style={{ backgroundColor: bgColor }}
      {...events}
    >
      <div className="saturation-white" />
      <div className="saturation-black" />
      <div
        ref={pointerRef}
        className="saturation-pointer"
        style={{
          left: `${hsva.s}%`,
          top: `${100 - hsva.v}%`,
        }}
      />
    </div>
  );
});

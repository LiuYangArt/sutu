import { memo, useCallback } from 'react';
import { usePointerDrag } from '@/hooks/usePointerDrag';
import './SaturationSquare.css';

interface SaturationSquareProps {
  hsva: { h: number; s: number; v: number; a: number };
  onChange: (newHsva: { h: number; s: number; v: number; a: number }) => void;
}

export const SaturationSquare = memo(function SaturationSquare({
  hsva,
  onChange,
}: SaturationSquareProps) {
  const handleChange = useCallback(
    ({ x, y, width, height }: { x: number; y: number; width: number; height: number }) => {
      const s = Math.max(0, Math.min((x / width) * 100, 100));
      const v = Math.max(0, Math.min(100 - (y / height) * 100, 100));

      // Use a functional update callback or ensure hsva dependency?
      // Since `onChange` will likely recreate if we pass `hsva` to dependency...
      // But we can just pass the new S/V relative to current.
      // Wait, inside useCallback, we need current `hsva.h`/`hsva.a` if we return full object?
      // Yes. So we need `hsva` in dependency.
      onChange({ ...hsva, s, v });
    },
    [hsva, onChange]
  );

  const { containerRef, events } = usePointerDrag(handleChange);

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
        className="saturation-pointer"
        style={{
          left: `${hsva.s}%`,
          top: `${100 - hsva.v}%`,
        }}
      />
    </div>
  );
});

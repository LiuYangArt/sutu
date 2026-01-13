import { memo, useCallback, useRef } from 'react';
import { usePointerDrag, PointerOutput } from '@/hooks/usePointerDrag';
import './VerticalHueSlider.css';

interface VerticalHueSliderProps {
  hue: number;
  onChange: (newHue: number) => void;
}

export const VerticalHueSlider = memo(function VerticalHueSlider({
  hue,
  onChange,
}: VerticalHueSliderProps) {
  const pointerRef = useRef<HTMLDivElement>(null);

  const handleChange = useCallback(
    ({ y, height }: PointerOutput) => {
      // 0% at top (0deg), 100% at bottom (360deg)
      const relativeY = Math.max(0, Math.min(y, height));
      const percent = relativeY / height;

      // Direct DOM update
      if (pointerRef.current) {
        pointerRef.current.style.top = `${percent * 100}%`;
      }

      onChange(percent * 360);
    },
    [onChange]
  );

  const { containerRef, events } = usePointerDrag(handleChange, {
    hideCursor: true,
  });

  // Convert hue to % position for the pointer
  const topPercent = (hue / 360) * 100;

  return (
    <div className="vertical-hue-slider" ref={containerRef} {...events}>
      <div className="vertical-hue-pointer" ref={pointerRef} style={{ top: `${topPercent}%` }} />
    </div>
  );
});

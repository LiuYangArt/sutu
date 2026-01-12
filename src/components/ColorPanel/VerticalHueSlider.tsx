import { memo, useCallback } from 'react';
import { usePointerDrag } from '@/hooks/usePointerDrag';
import './VerticalHueSlider.css';

interface VerticalHueSliderProps {
  hue: number;
  onChange: (newHue: number) => void;
}

export const VerticalHueSlider = memo(function VerticalHueSlider({
  hue,
  onChange,
}: VerticalHueSliderProps) {
  const handleChange = useCallback(
    (data: { y: number; height: number; width: number }) => {
      // 0% at top (0deg), 100% at bottom (360deg)
      const relativeY = Math.max(0, Math.min(data.y, data.height));
      const percent = relativeY / data.height;
      onChange(percent * 360);
    },
    [onChange]
  );

  const { containerRef, events } = usePointerDrag(handleChange);

  // Convert hue to % position for the pointer
  const topPercent = (hue / 360) * 100;

  return (
    <div className="vertical-hue-slider" ref={containerRef} {...events}>
      <div className="vertical-hue-pointer" style={{ top: `${topPercent}%` }} />
    </div>
  );
});

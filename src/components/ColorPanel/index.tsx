import { SaturationSquare } from './SaturationSquare';
import { useToolStore } from '@/stores/tool';
import { useState, useEffect, useCallback } from 'react';
import { hexToHsva, hsvaToHex, normalizeHex } from '@/utils/colorUtils';
import { VerticalHueSlider } from './VerticalHueSlider';
import { ArrowLeftRight, RotateCcw } from 'lucide-react';
import './ColorPanel.css';

interface HsvaColor {
  h: number;
  s: number;
  v: number;
  a: number;
}

function isSameHsva(a: HsvaColor, b: HsvaColor): boolean {
  return a.h === b.h && a.s === b.s && a.v === b.v && a.a === b.a;
}

function isSameColorToken(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function ColorPanel() {
  const { brushColor, backgroundColor, setBrushColor, swapColors, resetColors } = useToolStore();

  // Use HSVA locally to control Saturation and Hue separately
  const [hsva, setHsva] = useState<HsvaColor>(() => hexToHsva(brushColor));

  // Also keep hex input synced
  const [hexInput, setHexInput] = useState(brushColor.replace('#', ''));

  // When store changes (e.g. undo/eyedropper), sync local state
  useEffect(() => {
    // Always sync hex input
    setHexInput(brushColor.replace('#', ''));
    const newHsva = hexToHsva(brushColor);
    setHsva((prev) => (isSameHsva(prev, newHsva) ? prev : newHsva));
  }, [brushColor]);

  // Handler for Saturation change
  const handleSaturationChange = useCallback(
    (newColor: HsvaColor) => {
      // newColor contains updated s,v. h,a are passed from props?
      // react-colorful Saturation calls onChange with { h, s, v, a } merged.
      const hex = hsvaToHex(newColor);
      if (!isSameColorToken(brushColor, hex)) {
        setBrushColor(hex);
      }
    },
    [brushColor, setBrushColor]
  );

  // Handler for Hue change
  const handleHueChange = useCallback(
    (newHue: number) => {
      const newHsva = { ...hsva, h: newHue };
      const hex = hsvaToHex(newHsva);
      if (!isSameColorToken(brushColor, hex)) {
        setBrushColor(hex);
      }
    },
    [hsva, brushColor, setBrushColor]
  );

  const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setHexInput(val);

    const clean = val.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length === 3 || clean.length === 6) {
      setBrushColor(`#${normalizeHex(clean)}`);
    }
  };

  const handleHexBlur = () => {
    setHexInput(brushColor.replace('#', ''));
  };

  return (
    <div className="color-panel">
      <div className="color-picker-wrapper">
        {/* Custom Layout: Saturation + Vertical Hue */}
        <div className="picker-area">
          <div className="saturation-wrapper">
            <SaturationSquare hsva={hsva} onChange={handleSaturationChange} />
          </div>
          <div className="hue-wrapper">
            <VerticalHueSlider hue={hsva.h} onChange={handleHueChange} />
          </div>
        </div>

        <div className="color-inputs">
          {/* Foreground/Background Color Swatches */}
          <div className="color-swatches">
            <div
              className="color-swatch foreground"
              style={{ backgroundColor: brushColor }}
              title="Foreground Color"
            />
            <div
              className="color-swatch background"
              style={{ backgroundColor: backgroundColor }}
              onClick={swapColors}
              title="Background Color (Click to swap)"
            />
          </div>
          <div className="color-actions">
            <button className="color-action-btn" onClick={swapColors} title="Swap Colors (X)">
              <ArrowLeftRight size={12} />
            </button>
            <button className="color-action-btn" onClick={resetColors} title="Reset Colors (D)">
              <RotateCcw size={12} />
            </button>
          </div>
          <div className="hex-input-wrapper">
            <span className="hex-prefix">#</span>
            <input
              type="text"
              value={hexInput}
              onChange={handleHexChange}
              onBlur={handleHexBlur}
              className="hex-input"
              maxLength={6}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

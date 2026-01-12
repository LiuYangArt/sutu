import { HexColorPicker } from 'react-colorful';
import { useToolStore } from '@/stores/tool';
import { useState, useEffect } from 'react';
import './ColorPanel.css';

export function ColorPanel() {
  const { brushColor, setBrushColor } = useToolStore();

  // Local state for the hex input to allow typing without constant re-formatting interruptions
  const [hexInput, setHexInput] = useState(brushColor.replace('#', ''));

  useEffect(() => {
    setHexInput(brushColor.replace('#', ''));
  }, [brushColor]);

  const handleColorChange = (newColor: string) => {
    // HexColorPicker returns hex string directly
    setBrushColor(newColor);
  };

  const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    // Allow any input, but validate only valid hex to update store
    setHexInput(val);

    // Check if valid hex (3 or 6 chars)
    const cleanHex = val.replace(/[^0-9a-fA-F]/g, '');
    if (cleanHex.length === 3 || cleanHex.length === 6) {
      // Expand 3 char hex
      let fullHex = cleanHex;
      if (cleanHex.length === 3) {
        fullHex = cleanHex
          .split('')
          .map((c) => c + c)
          .join('');
      }
      setBrushColor(`#${fullHex}`);
    }
  };

  const handleHexBlur = () => {
    // On blur, reset input to actual current color to ensure consistency
    setHexInput(brushColor.replace('#', ''));
  };

  return (
    <div className="color-panel">
      <h3>Color</h3>
      <div className="color-picker-wrapper">
        <HexColorPicker color={brushColor} onChange={handleColorChange} />

        <div className="color-inputs">
          <div className="color-preview" style={{ backgroundColor: brushColor }} />
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

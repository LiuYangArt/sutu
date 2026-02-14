import { useCallback, useEffect, useState } from 'react';
import { ArrowLeftRight, Hash, Plus, RotateCcw } from 'lucide-react';
import { SaturationSquare } from './SaturationSquare';
import { VerticalHueSlider } from './VerticalHueSlider';
import { useToolStore, RECENT_SWATCH_LIMIT } from '@/stores/tool';
import { useToastStore } from '@/stores/toast';
import { hexToHsva, hsvaToHex, normalizeHex } from '@/utils/colorUtils';
import './ColorPanel.css';

interface HsvaColor {
  h: number;
  s: number;
  v: number;
  a: number;
}
const CONTROL_ICON_SIZE = 12;

function isSameHsva(a: HsvaColor, b: HsvaColor): boolean {
  return a.h === b.h && a.s === b.s && a.v === b.v && a.a === b.a;
}

function isSameColorToken(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function toCanonicalHex(color: string): string {
  const raw = color.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) {
    return '#000000';
  }
  return `#${normalizeHex(raw).toUpperCase()}`;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboardApi = (
    navigator as Navigator & {
      clipboard?: { writeText?: (value: string) => Promise<void> };
    }
  ).clipboard;

  if (clipboardApi?.writeText) {
    try {
      await clipboardApi.writeText(text);
      return true;
    } catch {
      // Fallback below.
    }
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

export function ColorPanel() {
  const {
    brushColor,
    backgroundColor,
    recentSwatches,
    setBrushColor,
    swapColors,
    resetColors,
    addRecentSwatch,
  } = useToolStore();
  const pushToast = useToastStore((s) => s.pushToast);

  // Use HSVA locally to control Saturation and Hue separately.
  const [hsva, setHsva] = useState<HsvaColor>(() => hexToHsva(brushColor));

  useEffect(() => {
    const newHsva = hexToHsva(brushColor);
    setHsva((prev) => (isSameHsva(prev, newHsva) ? prev : newHsva));
  }, [brushColor]);

  const handleSaturationChange = useCallback(
    (newColor: HsvaColor) => {
      const hex = hsvaToHex(newColor);
      if (!isSameColorToken(brushColor, hex)) {
        setBrushColor(hex);
      }
    },
    [brushColor, setBrushColor]
  );

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

  const handleCopyHex = useCallback(async () => {
    const hex = toCanonicalHex(brushColor);
    const copied = await copyTextToClipboard(hex);
    if (copied) {
      pushToast(`Copied ${hex}`, { variant: 'success' });
    } else {
      pushToast('Copy failed', { variant: 'error' });
    }
  }, [brushColor, pushToast]);

  const handleAddSwatch = useCallback(() => {
    addRecentSwatch(brushColor);
  }, [addRecentSwatch, brushColor]);

  return (
    <div className="color-panel">
      <div className="color-layout">
        <div className="color-control-column">
          <div className="main-swatches-card">
            <button
              type="button"
              className="main-color-swatch background"
              style={{ backgroundColor: backgroundColor }}
              title="Background Color"
              aria-label="Background Color"
            />
            <button
              type="button"
              className="main-color-swatch foreground"
              style={{ backgroundColor: brushColor }}
              title="Foreground Color"
              aria-label="Foreground Color"
            />
          </div>

          <div className="control-button-grid">
            <button
              type="button"
              className="control-cell-btn color-action-btn"
              onClick={swapColors}
              title="Swap Colors (X)"
              aria-label="Swap Colors"
            >
              <ArrowLeftRight size={CONTROL_ICON_SIZE} />
            </button>
            <button
              type="button"
              className="control-cell-btn color-action-btn"
              onClick={resetColors}
              title="Reset Colors (D)"
              aria-label="Reset Colors"
            >
              <RotateCcw size={CONTROL_ICON_SIZE} />
            </button>
            <button
              type="button"
              className="control-cell-btn color-action-btn"
              onClick={() => void handleCopyHex()}
              title="Copy HEX"
              aria-label="HEX"
            >
              <Hash size={CONTROL_ICON_SIZE} />
            </button>
            <button
              type="button"
              className="control-cell-btn color-action-btn"
              onClick={handleAddSwatch}
              title="Add current foreground color to swatches"
              aria-label="Add Swatch"
            >
              <Plus size={CONTROL_ICON_SIZE} />
            </button>
          </div>

          <div className="swatch-grid" role="list" aria-label="Recent Swatches">
            {Array.from({ length: RECENT_SWATCH_LIMIT }).map((_, index) => {
              const swatch = recentSwatches[index];
              if (!swatch) {
                return (
                  <button
                    key={`empty-${index}`}
                    type="button"
                    className="recent-swatch-slot empty"
                    data-testid="recent-swatch-slot"
                    aria-label={`Empty swatch slot ${index + 1}`}
                    disabled
                  />
                );
              }

              return (
                <button
                  key={swatch}
                  type="button"
                  className="recent-swatch-slot"
                  data-testid="recent-swatch-slot"
                  style={{ backgroundColor: swatch }}
                  aria-label={`Swatch ${index + 1}: ${swatch}`}
                  title={swatch}
                  onClick={() => setBrushColor(swatch)}
                />
              );
            })}
          </div>
        </div>

        <div className="color-picker-wrapper">
          <div className="picker-area">
            <div className="saturation-wrapper">
              <SaturationSquare hsva={hsva} onChange={handleSaturationChange} />
            </div>
            <div className="hue-wrapper">
              <VerticalHueSlider hue={hsva.h} onChange={handleHueChange} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

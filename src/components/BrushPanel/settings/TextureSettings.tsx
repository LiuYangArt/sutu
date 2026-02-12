import { useState } from 'react';
import { CirclePlus } from 'lucide-react';
import { usePatternLibraryStore } from '@/stores/pattern';
import { useToastStore } from '@/stores/toast';
import { useToolStore, ControlSource } from '@/stores/tool';
import { TEXTURE_SCALE_SLIDER_CONFIG } from '@/utils/sliderScales';
import { depthControlToSource, sourceToDepthControl } from '@/utils/textureDynamics';
import { TextureBlendMode } from '../types';
import { SliderRow, SelectRow, SelectOption } from '../BrushPanelComponents';
import { PatternPicker } from './PatternPicker';

/** Control options for Texture Depth */
const DEPTH_CONTROL_OPTIONS: SelectOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'fade', label: 'Fade' },
  { value: 'penPressure', label: 'Pen Pressure' },
  { value: 'penTilt', label: 'Pen Tilt' },
  { value: 'rotation', label: 'Rotation' },
];

/** Texture blend mode options */
const BLEND_MODE_OPTIONS: { value: TextureBlendMode; label: string }[] = [
  { value: 'multiply', label: 'Multiply' },
  { value: 'subtract', label: 'Subtract' },
  { value: 'darken', label: 'Darken' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'colorDodge', label: 'Color Dodge' },
  { value: 'colorBurn', label: 'Color Burn' },
  { value: 'linearBurn', label: 'Linear Burn' },
  { value: 'hardMix', label: 'Hard Mix' },
  { value: 'linearHeight', label: 'Linear Height' },
  { value: 'height', label: 'Height' },
];

export function TextureSettings(): JSX.Element {
  const {
    textureEnabled,
    textureSettings,
    setTextureSettings,
    patterns: brushPatterns,
  } = useToolStore();
  const [isAddingPattern, setIsAddingPattern] = useState(false);
  const libraryPatterns = usePatternLibraryStore((s) => s.patterns);
  const addPatternFromBrush = usePatternLibraryStore((s) => s.addPatternFromBrush);
  const pushToast = useToastStore((s) => s.pushToast);
  const patternId = textureSettings?.patternId;

  const disabled = !textureEnabled;
  const depthControlSource = depthControlToSource(textureSettings.depthControl);
  const brushPatternFallback = patternId
    ? (brushPatterns.find((pattern) => pattern.id === patternId) ?? null)
    : null;
  const isPatternInLibrary = patternId
    ? libraryPatterns.some((pattern) => pattern.id === patternId)
    : false;
  const canAddCurrentPattern = !disabled && !!patternId && !isPatternInLibrary;

  // Controls related to individual tip variation are disabled unless Texture Each Tip is on
  const tipVariationDisabled = disabled || !textureSettings.textureEachTip;

  const handlePatternSelect = (newPatternId: string | null) => {
    setTextureSettings({ patternId: newPatternId });
  };

  const handleAddCurrentPattern = async () => {
    if (!canAddCurrentPattern || !patternId) return;
    setIsAddingPattern(true);
    try {
      const result = await addPatternFromBrush(patternId, brushPatternFallback?.name);
      setTextureSettings({ patternId: result.pattern.id });
      pushToast(
        result.added
          ? 'Pattern added to library'
          : 'Pattern already exists, switched to existing item',
        {
          variant: result.added ? 'success' : 'info',
        }
      );
    } catch (error) {
      console.error('[TextureSettings] Failed to add pattern from brush:', error);
      pushToast('Failed to add pattern', { variant: 'error' });
    } finally {
      setIsAddingPattern(false);
    }
  };

  return (
    <div className="brush-panel-section">
      {/* Section header */}
      <div className="section-header-row">
        <div className="section-checkbox-label">
          <h4>Texture</h4>
        </div>
      </div>

      {/* Pattern Picker */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`} style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 60 }}>
            Pattern
          </span>
          <PatternPicker
            selectedId={patternId ?? null}
            onSelect={handlePatternSelect}
            disabled={disabled}
            thumbnailSize={32}
            fallbackPattern={
              brushPatternFallback
                ? {
                    id: brushPatternFallback.id,
                    name: brushPatternFallback.name,
                    width: brushPatternFallback.width,
                    height: brushPatternFallback.height,
                  }
                : null
            }
          />

          <label
            className={`flip-checkbox ${disabled ? 'disabled' : ''}`}
            style={{ marginLeft: 8 }}
          >
            <input
              type="checkbox"
              checked={textureSettings.invert}
              onChange={(e) => setTextureSettings({ invert: e.target.checked })}
              disabled={disabled}
            />
            <span>Invert</span>
          </label>

          <button
            type="button"
            aria-label="Add pattern to library"
            title={
              canAddCurrentPattern
                ? 'Add current brush pattern to library'
                : 'Pattern already in library'
            }
            onClick={() => void handleAddCurrentPattern()}
            disabled={!canAddCurrentPattern || isAddingPattern}
            style={{
              width: 26,
              height: 26,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4,
              border: '1px solid var(--border, #5a6474)',
              background: 'var(--bg-secondary, #1b2432)',
              color: 'var(--text-primary, #f2f6ff)',
              cursor: !canAddCurrentPattern || isAddingPattern ? 'not-allowed' : 'pointer',
              opacity: !canAddCurrentPattern || isAddingPattern ? 0.5 : 1,
              padding: 0,
              lineHeight: 0,
            }}
          >
            <CirclePlus size={14} strokeWidth={2.25} />
          </button>
        </div>
      </div>

      {/* Basic texture adjustments */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Scale"
          value={textureSettings.scale}
          min={1}
          max={1000}
          nonLinearConfig={TEXTURE_SCALE_SLIDER_CONFIG}
          displayValue={`${Math.round(textureSettings.scale)}%`}
          onChange={(v) => setTextureSettings({ scale: v })}
        />

        <SliderRow
          label="Brightness"
          value={textureSettings.brightness}
          min={-150}
          max={150}
          displayValue={`${textureSettings.brightness}`}
          onChange={(v) => setTextureSettings({ brightness: v })}
        />

        <SliderRow
          label="Contrast"
          value={textureSettings.contrast}
          min={-50}
          max={50}
          displayValue={`${textureSettings.contrast}`}
          onChange={(v) => setTextureSettings({ contrast: v })}
        />
      </div>

      {/* Texture Each Tip and Invert toggles */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <div className="setting-checkbox-row">
          <label className={`flip-checkbox ${disabled ? 'disabled' : ''}`}>
            <input
              type="checkbox"
              checked={textureSettings.textureEachTip}
              onChange={(e) => setTextureSettings({ textureEachTip: e.target.checked })}
              disabled={disabled}
            />
            <span>Texture Each Tip</span>
          </label>
        </div>

        <SelectRow
          label="Mode"
          value={textureSettings.mode}
          options={BLEND_MODE_OPTIONS}
          onChange={(v) => setTextureSettings({ mode: v as TextureBlendMode })}
          disabled={disabled}
        />

        <SliderRow
          label="Depth"
          value={textureSettings.depth}
          min={0}
          max={100}
          displayValue={`${Math.round(textureSettings.depth)}%`}
          onChange={(v) => setTextureSettings({ depth: v })}
        />

        <SliderRow
          label="Minimum Depth"
          value={textureSettings.minimumDepth}
          min={0}
          max={100}
          displayValue={`${Math.round(textureSettings.minimumDepth)}%`}
          onChange={(v) => setTextureSettings({ minimumDepth: v })}
          disabled={tipVariationDisabled}
        />

        <SliderRow
          label="Depth Jitter"
          value={textureSettings.depthJitter}
          min={0}
          max={100}
          displayValue={`${Math.round(textureSettings.depthJitter)}%`}
          onChange={(v) => setTextureSettings({ depthJitter: v })}
          disabled={tipVariationDisabled}
        />

        <SelectRow
          label="Control"
          value={depthControlSource}
          options={DEPTH_CONTROL_OPTIONS}
          onChange={(v) =>
            setTextureSettings({ depthControl: sourceToDepthControl(v as ControlSource) })
          }
          disabled={tipVariationDisabled}
        />
      </div>
    </div>
  );
}

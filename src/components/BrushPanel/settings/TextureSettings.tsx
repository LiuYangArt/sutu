/**
 * TextureSettings - Photoshop-compatible Texture panel
 *
 * Controls how pattern/texture modifies brush alpha:
 * - Pattern selection (preview)
 * - Scale, Brightness, Contrast
 * - Texture Each Tip toggle
 * - Mode (blend mode for texture application)
 * - Depth + Minimum + Jitter + Control
 * - Invert toggle
 */

import { useToolStore, ControlSource } from '@/stores/tool';
import { TextureBlendMode } from '../types';
import {
  SliderRow,
  ControlSourceSelect,
  SelectRow,
  ControlSourceOption,
} from '../BrushPanelComponents';

/** Control options for Texture Depth */
const DEPTH_CONTROL_OPTIONS: ControlSourceOption[] = [
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

/** Map depthControl number to ControlSource */
function depthControlToSource(value: number): ControlSource {
  switch (value) {
    case 0:
      return 'off';
    case 1:
      return 'fade';
    case 2:
      return 'penPressure';
    case 3:
      return 'penTilt';
    case 4:
      return 'rotation';
    default:
      return 'off';
  }
}

/** Map ControlSource to depthControl number */
function sourceToDepthControl(source: ControlSource): number {
  switch (source) {
    case 'off':
      return 0;
    case 'fade':
      return 1;
    case 'penPressure':
      return 2;
    case 'penTilt':
      return 3;
    case 'rotation':
      return 4;
    default:
      return 0;
  }
}

export function TextureSettings(): JSX.Element {
  const { textureEnabled, textureSettings, setTextureSettings, toggleTexture } = useToolStore();

  const disabled = !textureEnabled;
  const depthControlSource = depthControlToSource(textureSettings.depthControl);

  // Controls related to individual tip variation are disabled unless Texture Each Tip is on
  const tipVariationDisabled = disabled || !textureSettings.textureEachTip;

  return (
    <div className="brush-panel-section">
      {/* Section header with enable checkbox */}
      <div className="section-header-row">
        <label className="section-checkbox-label">
          <input type="checkbox" checked={textureEnabled} onChange={toggleTexture} />
          <h4>Texture</h4>
        </label>
      </div>

      {/* Basic texture adjustments */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Scale"
          value={textureSettings.scale}
          min={10}
          max={200}
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

        <ControlSourceSelect
          label="Control"
          value={depthControlSource}
          options={DEPTH_CONTROL_OPTIONS}
          onChange={(v) =>
            setTextureSettings({ depthControl: sourceToDepthControl(v as ControlSource) })
          }
          disabled={tipVariationDisabled}
        />

        <div className="setting-checkbox-row" style={{ marginTop: '8px' }}>
          <label className={`flip-checkbox ${disabled ? 'disabled' : ''}`}>
            <input
              type="checkbox"
              checked={textureSettings.invert}
              onChange={(e) => setTextureSettings({ invert: e.target.checked })}
              disabled={disabled}
            />
            <span>Invert</span>
          </label>
        </div>
      </div>
    </div>
  );
}

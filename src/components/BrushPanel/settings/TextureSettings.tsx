import { useState } from 'react';
import { useToolStore, ControlSource } from '@/stores/tool';
import { TextureBlendMode } from '../types';
import { SliderRow, SelectRow, SelectOption } from '../BrushPanelComponents';
import { LZ4Image } from '@/components/common/LZ4Image';

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

const DEPTH_SOURCE_MAP = ['off', 'fade', 'penPressure', 'penTilt', 'rotation'] as const;

/** Map depthControl number to ControlSource */
function depthControlToSource(value: number): ControlSource {
  return (DEPTH_SOURCE_MAP[value] as ControlSource) || 'off';
}

/** Map ControlSource to depthControl number */
function sourceToDepthControl(source: ControlSource): number {
  const index = DEPTH_SOURCE_MAP.indexOf(source as any);
  return index >= 0 ? index : 0;
}

export function TextureSettings(): JSX.Element {
  const { textureEnabled, textureSettings, setTextureSettings, toggleTexture } = useToolStore();
  const [showPreview, setShowPreview] = useState(false);
  const patternId = textureSettings?.patternId;
  // Fix for Windows Tauri v2 custom protocol
  const patternUrl = patternId ? `http://project.localhost/pattern/${patternId}` : null;

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

        {/* Pattern Preview with hover popup */}
        <div
          style={{
            position: 'relative',
            marginLeft: 'auto',
          }}
          onMouseEnter={() => patternUrl && setShowPreview(true)}
          onMouseLeave={() => setShowPreview(false)}
        >
          {/* Thumbnail container */}
          <div
            className="pattern-preview"
            title={patternId ? 'Hover for preview' : 'No Pattern'}
            style={{
              width: 40,
              height: 40,
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg-tertiary)',
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '4px',
              cursor: patternUrl ? 'pointer' : 'default',
            }}
          >
            {patternUrl ? (
              <LZ4Image
                src={patternUrl}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                alt="Pattern"
              />
            ) : (
              <span style={{ fontSize: 10, color: 'var(--color-text-secondary)', opacity: 0.5 }}>
                None
              </span>
            )}
          </div>

          {/* Hover preview popup - outside overflow container */}
          {showPreview && patternUrl && (
            <div
              style={{
                position: 'fixed',
                left: 'calc(100vw - 600px)',
                top: 100,
                padding: 8,
                background: 'var(--color-bg-primary)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                zIndex: 9999,
                pointerEvents: 'none',
              }}
            >
              <LZ4Image
                src={patternUrl}
                style={{
                  width: 'auto',
                  height: 'auto',
                  maxWidth: 496,
                  maxHeight: 496,
                  display: 'block',
                }}
                alt="Pattern Preview"
              />
            </div>
          )}
        </div>
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

        <SelectRow
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

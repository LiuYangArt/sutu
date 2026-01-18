import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  useToolStore,
  PressureCurve,
  BrushMaskType,
  RenderMode,
  ColorBlendMode,
  GPURenderScaleMode,
  BrushTexture,
} from '@/stores/tool';
import './BrushPanel.css';

/** Brush preset from ABR import */
interface BrushPreset {
  id: string;
  name: string;
  diameter: number;
  spacing: number;
  hardness: number;
  angle: number;
  roundness: number;
  hasTexture: boolean;
  textureData: string | null;
  textureWidth: number | null;
  textureHeight: number | null;
  sizePressure: boolean;
  opacityPressure: boolean;
}

const PRESSURE_CURVES: { id: PressureCurve; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'soft', label: 'Soft' },
  { id: 'hard', label: 'Hard' },
  { id: 'sCurve', label: 'S-Curve' },
];

const RENDER_MODES: { id: RenderMode; label: string; description: string }[] = [
  { id: 'gpu', label: 'GPU', description: 'WebGPU accelerated' },
  { id: 'cpu', label: 'CPU', description: 'Canvas 2D fallback' },
];

const COLOR_BLEND_MODES: { id: ColorBlendMode; label: string; description: string }[] = [
  { id: 'srgb', label: 'sRGB', description: 'Match CPU rendering exactly' },
  { id: 'linear', label: 'Linear', description: 'Smoother gradients (default)' },
];

const GPU_RENDER_SCALE_MODES: { id: GPURenderScaleMode; label: string; description: string }[] = [
  { id: 'off', label: 'Off', description: 'Always render at full resolution' },
  {
    id: 'auto',
    label: 'Auto',
    description: 'Downsample for soft large brushes (hardness < 70, size > 300)',
  },
];

/** Pressure toggle button component */
function PressureToggle({
  enabled,
  onToggle,
  title,
}: {
  enabled: boolean;
  onToggle: () => void;
  title: string;
}): JSX.Element {
  return (
    <button
      className={`pressure-toggle ${enabled ? 'active' : ''}`}
      onClick={onToggle}
      title={title}
    >
      P
    </button>
  );
}

/** Slider row component for brush parameters */
function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  displayValue,
  onChange,
  pressureEnabled,
  onPressureToggle,
  pressureTitle,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  displayValue: string;
  onChange: (value: number) => void;
  pressureEnabled?: boolean;
  onPressureToggle?: () => void;
  pressureTitle?: string;
}): JSX.Element {
  return (
    <div className="brush-setting-row">
      <span className="brush-setting-label">{label}</span>
      {onPressureToggle && pressureTitle && (
        <PressureToggle
          enabled={pressureEnabled ?? false}
          onToggle={onPressureToggle}
          title={pressureTitle}
        />
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="brush-setting-value">{displayValue}</span>
    </div>
  );
}

/** Default procedural brush preset (always first in the list) */
const DEFAULT_ROUND_BRUSH: BrushPreset = {
  id: '__default_round__',
  name: 'Round Brush',
  diameter: 20,
  spacing: 25,
  hardness: 100,
  angle: 0,
  roundness: 100,
  hasTexture: false,
  textureData: null,
  textureWidth: null,
  textureHeight: null,
  sizePressure: true,
  opacityPressure: false,
};

export function BrushPanel(): JSX.Element {
  const [importedPresets, setImportedPresets] = useState<BrushPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>(DEFAULT_ROUND_BRUSH.id);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const {
    brushSize,
    setBrushSize,
    brushFlow,
    setBrushFlow,
    brushOpacity,
    setBrushOpacity,
    brushHardness,
    setBrushHardness,
    brushMaskType,
    setBrushMaskType,
    brushSpacing,
    setBrushSpacing,
    brushRoundness,
    setBrushRoundness,
    brushAngle,
    setBrushAngle,
    pressureCurve,
    setPressureCurve,
    pressureSizeEnabled,
    togglePressureSize,
    pressureFlowEnabled,
    togglePressureFlow,
    pressureOpacityEnabled,
    togglePressureOpacity,
    renderMode,
    setRenderMode,
    colorBlendMode,
    setColorBlendMode,
    gpuRenderScaleMode,
    setGpuRenderScaleMode,
    setBrushTexture,
    clearBrushTexture,
  } = useToolStore();

  /** Import ABR file */
  const handleImportABR = async () => {
    setIsImporting(true);
    setImportError(null);

    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Photoshop Brushes', extensions: ['abr'] }],
      });

      if (selected) {
        const presets = await invoke<BrushPreset[]>('import_abr_file', {
          path: selected,
        });
        setImportedPresets(presets);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setImportError(message);
      console.error('ABR import failed:', err);
    } finally {
      setIsImporting(false);
    }
  };

  /** Apply preset to current brush settings */
  const applyPreset = (preset: BrushPreset) => {
    // Update selected preset ID for visual feedback
    setSelectedPresetId(preset.id);

    setBrushSize(Math.round(preset.diameter));
    setBrushHardness(Math.round(preset.hardness));
    setBrushSpacing(preset.spacing / 100);
    setBrushRoundness(Math.round(preset.roundness));
    setBrushAngle(Math.round(preset.angle));

    // Apply texture if preset has one
    if (preset.hasTexture && preset.textureData && preset.textureWidth && preset.textureHeight) {
      const texture: BrushTexture = {
        data: preset.textureData,
        width: preset.textureWidth,
        height: preset.textureHeight,
      };
      setBrushTexture(texture);
    } else {
      // Clear texture for procedural brushes
      clearBrushTexture();
    }
  };

  return (
    <div className="brush-panel">
      <div className="brush-panel-section">
        <h4>Brush Tip</h4>

        <SliderRow
          label="Size"
          value={brushSize}
          min={1}
          max={500}
          displayValue={`${brushSize}px`}
          onChange={setBrushSize}
          pressureEnabled={pressureSizeEnabled}
          onPressureToggle={togglePressureSize}
          pressureTitle="Pressure affects size"
        />

        <SliderRow
          label="Hardness"
          value={brushHardness}
          min={0}
          max={100}
          displayValue={`${brushHardness}%`}
          onChange={setBrushHardness}
        />

        <div className="brush-setting-row">
          <span className="brush-setting-label">Softness</span>
          <select
            value={brushMaskType}
            onChange={(e) => setBrushMaskType(e.target.value as BrushMaskType)}
            className="brush-select"
          >
            <option value="gaussian">Gaussian (Smooth)</option>
            <option value="default">Default</option>
          </select>
        </div>

        <SliderRow
          label="Roundness"
          value={brushRoundness}
          min={1}
          max={100}
          displayValue={`${brushRoundness}%`}
          onChange={setBrushRoundness}
        />

        <SliderRow
          label="Angle"
          value={brushAngle}
          min={0}
          max={360}
          displayValue={`${brushAngle}°`}
          onChange={setBrushAngle}
        />

        <SliderRow
          label="Spacing"
          value={Math.round(brushSpacing * 100)}
          min={1}
          max={100}
          displayValue={`${Math.round(brushSpacing * 100)}%`}
          onChange={(v) => setBrushSpacing(v / 100)}
        />
      </div>

      <div className="brush-panel-section">
        <h4>Transfer</h4>

        <SliderRow
          label="Flow"
          value={Math.round(brushFlow * 100)}
          min={1}
          max={100}
          displayValue={`${Math.round(brushFlow * 100)}%`}
          onChange={(v) => setBrushFlow(v / 100)}
          pressureEnabled={pressureFlowEnabled}
          onPressureToggle={togglePressureFlow}
          pressureTitle="Pressure affects flow"
        />

        <SliderRow
          label="Opacity"
          value={Math.round(brushOpacity * 100)}
          min={1}
          max={100}
          displayValue={`${Math.round(brushOpacity * 100)}%`}
          onChange={(v) => setBrushOpacity(v / 100)}
          pressureEnabled={pressureOpacityEnabled}
          onPressureToggle={togglePressureOpacity}
          pressureTitle="Pressure affects opacity"
        />

        <div className="brush-setting-row">
          <span className="brush-setting-label">Curve</span>
          <select
            value={pressureCurve}
            onChange={(e) => setPressureCurve(e.target.value as PressureCurve)}
            className="brush-select"
          >
            {PRESSURE_CURVES.map((curve) => (
              <option key={curve.id} value={curve.id}>
                {curve.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="brush-panel-section">
        <h4>Renderer</h4>
        <div className="brush-setting-row">
          <span className="brush-setting-label">Mode</span>
          <select
            value={renderMode}
            onChange={(e) => setRenderMode(e.target.value as RenderMode)}
            className="brush-select"
            title={RENDER_MODES.find((m) => m.id === renderMode)?.description}
          >
            {RENDER_MODES.map((mode) => (
              <option key={mode.id} value={mode.id} title={mode.description}>
                {mode.label}
              </option>
            ))}
          </select>
        </div>

        {renderMode === 'gpu' && (
          <div className="brush-setting-row">
            <span className="brush-setting-label">Blending</span>
            <select
              value={colorBlendMode}
              onChange={(e) => setColorBlendMode(e.target.value as ColorBlendMode)}
              className="brush-select"
              title={COLOR_BLEND_MODES.find((m) => m.id === colorBlendMode)?.description}
            >
              {COLOR_BLEND_MODES.map((mode) => (
                <option key={mode.id} value={mode.id} title={mode.description}>
                  {mode.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {renderMode === 'gpu' && (
          <div className="brush-setting-row">
            <span className="brush-setting-label">Downsample</span>
            <select
              value={gpuRenderScaleMode}
              onChange={(e) => setGpuRenderScaleMode(e.target.value as GPURenderScaleMode)}
              className="brush-select"
              title={GPU_RENDER_SCALE_MODES.find((m) => m.id === gpuRenderScaleMode)?.description}
            >
              {GPU_RENDER_SCALE_MODES.map((mode) => (
                <option key={mode.id} value={mode.id} title={mode.description}>
                  {mode.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ABR Import Section */}
      <div className="brush-panel-section">
        <h4>Brush Presets</h4>
        <button className="abr-import-btn" onClick={handleImportABR} disabled={isImporting}>
          {isImporting ? 'Importing...' : 'Import ABR'}
        </button>

        {importError && <div className="abr-error">{importError}</div>}

        <div className="abr-preset-grid">
          {/* Default round brush - always first */}
          <button
            className={`abr-preset-item ${selectedPresetId === DEFAULT_ROUND_BRUSH.id ? 'selected' : ''}`}
            onClick={() => applyPreset(DEFAULT_ROUND_BRUSH)}
            title="Round Brush (Default)\nProcedural brush with soft edges"
          >
            <div className="abr-preset-round-icon" />
          </button>

          {/* Imported presets */}
          {importedPresets.map((preset) => (
            <button
              key={preset.id}
              className={`abr-preset-item ${selectedPresetId === preset.id ? 'selected' : ''}`}
              onClick={() => applyPreset(preset)}
              title={`${preset.name}\n${preset.diameter}px, ${preset.hardness}% hardness`}
            >
              {preset.hasTexture && preset.textureData ? (
                <img
                  src={`data:image/png;base64,${preset.textureData}`}
                  alt={preset.name}
                  className="abr-preset-texture"
                />
              ) : (
                <div className="abr-preset-placeholder">{Math.round(preset.diameter)}</div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

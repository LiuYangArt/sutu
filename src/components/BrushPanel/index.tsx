import {
  useToolStore,
  PressureCurve,
  BrushMaskType,
  RenderMode,
  ColorBlendMode,
} from '@/stores/tool';
import './BrushPanel.css';

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

export function BrushPanel(): JSX.Element {
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
  } = useToolStore();

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
      </div>
    </div>
  );
}

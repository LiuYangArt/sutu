import { useToolStore, BrushMaskType } from '@/stores/tool';
import { SliderRow } from '../BrushPanelComponents';

export function BrushTipShape(): JSX.Element {
  const {
    brushSize,
    setBrushSize,
    brushHardness,
    setBrushHardness,
    brushMaskType,
    setBrushMaskType,
    brushRoundness,
    setBrushRoundness,
    brushAngle,
    setBrushAngle,
    brushSpacing,
    setBrushSpacing,
    pressureSizeEnabled,
    togglePressureSize,
  } = useToolStore();

  return (
    <div className="brush-panel-section">
      <h4>Brush Tip Shape</h4>

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
  );
}

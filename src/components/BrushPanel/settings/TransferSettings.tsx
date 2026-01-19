import { useToolStore, PressureCurve } from '@/stores/tool';
import { SliderRow } from '../BrushPanelComponents';

const PRESSURE_CURVES: { id: PressureCurve; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'soft', label: 'Soft' },
  { id: 'hard', label: 'Hard' },
  { id: 'sCurve', label: 'S-Curve' },
];

export function TransferSettings(): JSX.Element {
  const {
    brushFlow,
    setBrushFlow,
    brushOpacity,
    setBrushOpacity,
    pressureCurve,
    setPressureCurve,
    pressureFlowEnabled,
    togglePressureFlow,
    pressureOpacityEnabled,
    togglePressureOpacity,
  } = useToolStore();

  return (
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
  );
}

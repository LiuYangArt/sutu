import { useToolStore } from '@/stores/tool';
import { SliderRow } from '../BrushPanelComponents';

export function TransferSettings(): JSX.Element {
  const {
    brushFlow,
    setBrushFlow,
    brushOpacity,
    setBrushOpacity,
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
    </div>
  );
}

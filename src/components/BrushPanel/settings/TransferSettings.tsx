/**
 * TransferSettings - Photoshop-compatible Transfer panel
 *
 * Controls how opacity and flow vary during a stroke:
 * - Opacity Jitter + Control + Minimum
 * - Flow Jitter + Control + Minimum
 */

import { useToolStore, ControlSource } from '@/stores/tool';
import { SliderRow, SelectRow, SelectOption } from '../BrushPanelComponents';

/** Control options for Transfer (no direction-based controls) */
const TRANSFER_CONTROL_OPTIONS: SelectOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'fade', label: 'Fade' },
  { value: 'penPressure', label: 'Pen Pressure' },
  { value: 'penTilt', label: 'Pen Tilt' },
  { value: 'rotation', label: 'Rotation' },
];

/** Reusable Jitter Group component for Opacity/Flow */
function JitterGroup({
  label,
  jitter,
  control,
  minimum,
  disabled,
  onJitterChange,
  onControlChange,
  onMinimumChange,
}: {
  label: string;
  jitter: number;
  control: ControlSource;
  minimum: number;
  disabled: boolean;
  onJitterChange: (v: number) => void;
  onControlChange: (v: ControlSource) => void;
  onMinimumChange: (v: number) => void;
}): JSX.Element {
  return (
    <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
      <SliderRow
        label={`${label} Jitter`}
        value={jitter}
        min={0}
        max={100}
        displayValue={`${jitter}%`}
        onChange={onJitterChange}
      />
      <SelectRow
        label="Control"
        value={control}
        options={TRANSFER_CONTROL_OPTIONS}
        onChange={(v) => onControlChange(v as ControlSource)}
        disabled={disabled}
      />
      {control !== 'off' && (
        <SliderRow
          label="Minimum"
          value={minimum}
          min={0}
          max={100}
          displayValue={`${minimum}%`}
          onChange={onMinimumChange}
        />
      )}
    </div>
  );
}

export function TransferSettings(): JSX.Element {
  const {
    brushFlow,
    setBrushFlow,
    brushOpacity,
    setBrushOpacity,
    transfer,
    setTransfer,
    transferEnabled,
  } = useToolStore();

  const disabled = !transferEnabled;

  return (
    <div className="brush-panel-section">
      {/* Section header with enable checkbox */}
      <div className="section-header-row">
        <h4>Transfer</h4>
      </div>

      {/* Base Flow/Opacity sliders (always visible) */}
      <div className="dynamics-group">
        <SliderRow
          label="Flow"
          value={Math.round(brushFlow * 100)}
          min={1}
          max={100}
          displayValue={`${Math.round(brushFlow * 100)}%`}
          onChange={(v) => setBrushFlow(v / 100)}
        />
        <SliderRow
          label="Opacity"
          value={Math.round(brushOpacity * 100)}
          min={1}
          max={100}
          displayValue={`${Math.round(brushOpacity * 100)}%`}
          onChange={(v) => setBrushOpacity(v / 100)}
        />
      </div>

      {/* Opacity Jitter Group */}
      <JitterGroup
        label="Opacity"
        jitter={transfer.opacityJitter}
        control={transfer.opacityControl}
        minimum={transfer.minimumOpacity}
        disabled={disabled}
        onJitterChange={(v) => setTransfer({ opacityJitter: v })}
        onControlChange={(v) => setTransfer({ opacityControl: v })}
        onMinimumChange={(v) => setTransfer({ minimumOpacity: v })}
      />

      {/* Flow Jitter Group */}
      <JitterGroup
        label="Flow"
        jitter={transfer.flowJitter}
        control={transfer.flowControl}
        minimum={transfer.minimumFlow}
        disabled={disabled}
        onJitterChange={(v) => setTransfer({ flowJitter: v })}
        onControlChange={(v) => setTransfer({ flowControl: v })}
        onMinimumChange={(v) => setTransfer({ minimumFlow: v })}
      />
    </div>
  );
}

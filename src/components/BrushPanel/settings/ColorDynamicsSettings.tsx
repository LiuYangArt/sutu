/**
 * ColorDynamicsSettings - Photoshop-compatible Color Dynamics panel
 *
 * Controls how brush color varies during a stroke:
 * - Foreground/Background Jitter + Control
 * - Hue/Saturation/Brightness Jitter
 * - Purity (global saturation adjustment)
 */

import { useToolStore, ControlSource } from '@/stores/tool';
import { SliderRow, SelectRow, SelectOption } from '../BrushPanelComponents';

/** Control options for Foreground/Background */
const FB_CONTROL_OPTIONS: SelectOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'fade', label: 'Fade' },
  { value: 'penPressure', label: 'Pen Pressure' },
  { value: 'penTilt', label: 'Pen Tilt' },
  { value: 'rotation', label: 'Rotation' },
];

export function ColorDynamicsSettings(): JSX.Element {
  const { colorDynamics, setColorDynamics, colorDynamicsEnabled, toggleColorDynamics } =
    useToolStore();

  const disabled = !colorDynamicsEnabled;

  return (
    <div className="brush-panel-section">
      {/* Section header with enable checkbox */}
      <div className="section-header-row">
        <label className="section-checkbox-label">
          <input type="checkbox" checked={colorDynamicsEnabled} onChange={toggleColorDynamics} />
          <h4>Color Dynamics</h4>
        </label>
      </div>

      {/* Foreground/Background Jitter Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Foreground/Background Jitter"
          value={colorDynamics.foregroundBackgroundJitter}
          min={0}
          max={100}
          displayValue={`${colorDynamics.foregroundBackgroundJitter}%`}
          onChange={(v) => setColorDynamics({ foregroundBackgroundJitter: v })}
        />
        <SelectRow
          label="Control"
          value={colorDynamics.foregroundBackgroundControl}
          options={FB_CONTROL_OPTIONS}
          onChange={(v) => setColorDynamics({ foregroundBackgroundControl: v as ControlSource })}
          disabled={disabled}
        />
      </div>

      {/* HSB Jitter Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Hue Jitter"
          value={colorDynamics.hueJitter}
          min={0}
          max={100}
          displayValue={`${colorDynamics.hueJitter}%`}
          onChange={(v) => setColorDynamics({ hueJitter: v })}
        />
        <SliderRow
          label="Saturation Jitter"
          value={colorDynamics.saturationJitter}
          min={0}
          max={100}
          displayValue={`${colorDynamics.saturationJitter}%`}
          onChange={(v) => setColorDynamics({ saturationJitter: v })}
        />
        <SliderRow
          label="Brightness Jitter"
          value={colorDynamics.brightnessJitter}
          min={0}
          max={100}
          displayValue={`${colorDynamics.brightnessJitter}%`}
          onChange={(v) => setColorDynamics({ brightnessJitter: v })}
        />
      </div>

      {/* Purity */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Purity"
          value={colorDynamics.purity}
          min={-100}
          max={100}
          displayValue={`${colorDynamics.purity > 0 ? '+' : ''}${colorDynamics.purity}%`}
          onChange={(v) => setColorDynamics({ purity: v })}
        />
      </div>
    </div>
  );
}

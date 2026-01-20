/**
 * ShapeDynamicsSettings - Photoshop-compatible Shape Dynamics panel
 *
 * Controls how brush shape varies during a stroke:
 * - Size Jitter + Control + Minimum Diameter
 * - Angle Jitter + Control
 * - Roundness Jitter + Control + Minimum Roundness
 * - Flip X/Y Jitter
 */

import { useToolStore, ControlSource } from '@/stores/tool';
import { SliderRow, ControlSourceSelect, ControlSourceOption } from '../BrushPanelComponents';

/** Available control source options */
const CONTROL_OPTIONS: ControlSourceOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'penPressure', label: 'Pen Pressure' },
  { value: 'penTilt', label: 'Pen Tilt' },
  { value: 'direction', label: 'Direction' },
  { value: 'initial', label: 'Initial Direction' },
];

export function ShapeDynamicsSettings(): JSX.Element {
  const {
    shapeDynamics,
    setShapeDynamics,
    shapeDynamicsEnabled,
    toggleShapeDynamics,
  } = useToolStore();

  const disabled = !shapeDynamicsEnabled;

  return (
    <div className="brush-panel-section">
      {/* Section header with enable checkbox */}
      <div className="section-header-row">
        <label className="section-checkbox-label">
          <input
            type="checkbox"
            checked={shapeDynamicsEnabled}
            onChange={toggleShapeDynamics}
          />
          <h4>Shape Dynamics</h4>
        </label>
      </div>

      {/* Size Jitter Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Size Jitter"
          value={shapeDynamics.sizeJitter}
          min={0}
          max={100}
          displayValue={`${shapeDynamics.sizeJitter}%`}
          onChange={(v) => setShapeDynamics({ sizeJitter: v })}
        />
        <ControlSourceSelect
          label="Control"
          value={shapeDynamics.sizeControl}
          options={CONTROL_OPTIONS}
          onChange={(v) => setShapeDynamics({ sizeControl: v as ControlSource })}
          disabled={disabled}
        />
        <SliderRow
          label="Minimum Diameter"
          value={shapeDynamics.minimumDiameter}
          min={0}
          max={100}
          displayValue={`${shapeDynamics.minimumDiameter}%`}
          onChange={(v) => setShapeDynamics({ minimumDiameter: v })}
        />
      </div>

      {/* Angle Jitter Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Angle Jitter"
          value={shapeDynamics.angleJitter}
          min={0}
          max={360}
          displayValue={`${shapeDynamics.angleJitter}°`}
          onChange={(v) => setShapeDynamics({ angleJitter: v })}
        />
        <ControlSourceSelect
          label="Control"
          value={shapeDynamics.angleControl}
          options={CONTROL_OPTIONS}
          onChange={(v) => setShapeDynamics({ angleControl: v as ControlSource })}
          disabled={disabled}
        />
      </div>

      {/* Roundness Jitter Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Roundness Jitter"
          value={shapeDynamics.roundnessJitter}
          min={0}
          max={100}
          displayValue={`${shapeDynamics.roundnessJitter}%`}
          onChange={(v) => setShapeDynamics({ roundnessJitter: v })}
        />
        <ControlSourceSelect
          label="Control"
          value={shapeDynamics.roundnessControl}
          options={CONTROL_OPTIONS}
          onChange={(v) => setShapeDynamics({ roundnessControl: v as ControlSource })}
          disabled={disabled}
        />
        <SliderRow
          label="Minimum Roundness"
          value={shapeDynamics.minimumRoundness}
          min={0}
          max={100}
          displayValue={`${shapeDynamics.minimumRoundness}%`}
          onChange={(v) => setShapeDynamics({ minimumRoundness: v })}
        />
      </div>

      {/* Flip Jitter Group */}
      <div className={`dynamics-group flip-group ${disabled ? 'disabled' : ''}`}>
        <label className="flip-checkbox">
          <input
            type="checkbox"
            checked={shapeDynamics.flipXJitter}
            onChange={() => setShapeDynamics({ flipXJitter: !shapeDynamics.flipXJitter })}
            disabled={disabled}
          />
          <span>Flip X Jitter</span>
        </label>
        <label className="flip-checkbox">
          <input
            type="checkbox"
            checked={shapeDynamics.flipYJitter}
            onChange={() => setShapeDynamics({ flipYJitter: !shapeDynamics.flipYJitter })}
            disabled={disabled}
          />
          <span>Flip Y Jitter</span>
        </label>
      </div>
    </div>
  );
}

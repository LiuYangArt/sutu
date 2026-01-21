/**
 * ScatterSettings - Photoshop-compatible Scattering panel
 *
 * Controls how brush dabs are scattered during a stroke:
 * - Scatter: displacement perpendicular to stroke direction
 * - Both Axes: scatter in both directions
 * - Count: number of dabs per spacing interval
 * - Count Jitter: randomize dab count
 */

import { useToolStore, ControlSource } from '@/stores/tool';
import { SliderRow, ControlSourceSelect, ControlSourceOption } from '../BrushPanelComponents';

/** Control options for Scatter (subset of Shape Dynamics options) */
const SCATTER_CONTROL_OPTIONS: ControlSourceOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'fade', label: 'Fade' },
  { value: 'penPressure', label: 'Pen Pressure' },
  { value: 'penTilt', label: 'Pen Tilt' },
];

export function ScatterSettings(): JSX.Element {
  const { scatter, setScatter, scatterEnabled, toggleScatter } = useToolStore();

  const disabled = !scatterEnabled;

  return (
    <div className="brush-panel-section">
      {/* Section header with enable checkbox */}
      <div className="section-header-row">
        <label className="section-checkbox-label">
          <input type="checkbox" checked={scatterEnabled} onChange={toggleScatter} />
          <h4>Scattering</h4>
        </label>
      </div>

      {/* Scatter Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Scatter"
          value={scatter.scatter}
          min={0}
          max={1000}
          displayValue={`${scatter.scatter}%`}
          onChange={(v) => setScatter({ scatter: v })}
        />
        <ControlSourceSelect
          label="Control"
          value={scatter.scatterControl}
          options={SCATTER_CONTROL_OPTIONS}
          onChange={(v) => setScatter({ scatterControl: v as ControlSource })}
          disabled={disabled}
        />
        <label className={`flip-checkbox ${disabled ? 'disabled' : ''}`}>
          <input
            type="checkbox"
            checked={scatter.bothAxes}
            onChange={() => setScatter({ bothAxes: !scatter.bothAxes })}
            disabled={disabled}
          />
          <span>Both Axes</span>
        </label>
      </div>

      {/* Count Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Count"
          value={scatter.count}
          min={1}
          max={16}
          displayValue={`${scatter.count}`}
          onChange={(v) => setScatter({ count: v })}
        />
        <ControlSourceSelect
          label="Control"
          value={scatter.countControl}
          options={SCATTER_CONTROL_OPTIONS}
          onChange={(v) => setScatter({ countControl: v as ControlSource })}
          disabled={disabled}
        />
        <SliderRow
          label="Count Jitter"
          value={scatter.countJitter}
          min={0}
          max={100}
          displayValue={`${scatter.countJitter}%`}
          onChange={(v) => setScatter({ countJitter: v })}
        />
      </div>
    </div>
  );
}

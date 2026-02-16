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
import { SliderRow, SelectRow, SelectOption } from '../BrushPanelComponents';
import { useI18n } from '@/i18n';

export function ShapeDynamicsSettings(): JSX.Element {
  const { t } = useI18n();
  const { shapeDynamics, setShapeDynamics, shapeDynamicsEnabled } = useToolStore();

  const disabled = !shapeDynamicsEnabled;
  const baseControlOptions: SelectOption[] = [
    { value: 'off', label: t('brushPanel.control.off') },
    { value: 'fade', label: t('brushPanel.control.fade') },
    { value: 'penPressure', label: t('brushPanel.control.penPressure') },
    { value: 'penTilt', label: t('brushPanel.control.penTilt') },
    { value: 'rotation', label: t('brushPanel.control.rotation') },
  ];

  const angleControlOptions: SelectOption[] = [
    ...baseControlOptions,
    { value: 'initial', label: t('brushPanel.control.initialDirection') },
    { value: 'direction', label: t('brushPanel.control.direction') },
  ];

  return (
    <div className="brush-panel-section">
      {/* Section header */}
      <div className="section-header-row">
        <h4>{t('brushPanel.tab.shapeDynamics')}</h4>
      </div>

      {/* Size Jitter Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label={t('brushPanel.shapeDynamics.sizeJitter')}
          value={shapeDynamics.sizeJitter}
          min={0}
          max={100}
          displayValue={`${shapeDynamics.sizeJitter}%`}
          onChange={(v) => setShapeDynamics({ sizeJitter: v })}
        />
        <SelectRow
          label={t('brushPanel.control.label')}
          value={shapeDynamics.sizeControl}
          options={baseControlOptions}
          onChange={(v) => setShapeDynamics({ sizeControl: v as ControlSource })}
          disabled={disabled}
        />
        <SliderRow
          label={t('brushPanel.shapeDynamics.minimumDiameter')}
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
          label={t('brushPanel.shapeDynamics.angleJitter')}
          value={shapeDynamics.angleJitter}
          min={0}
          max={360}
          displayValue={`${shapeDynamics.angleJitter}°`}
          onChange={(v) => setShapeDynamics({ angleJitter: v })}
        />
        <SelectRow
          label={t('brushPanel.control.label')}
          value={shapeDynamics.angleControl}
          options={angleControlOptions}
          onChange={(v) => setShapeDynamics({ angleControl: v as ControlSource })}
          disabled={disabled}
        />
      </div>

      {/* Roundness Jitter Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label={t('brushPanel.shapeDynamics.roundnessJitter')}
          value={shapeDynamics.roundnessJitter}
          min={0}
          max={100}
          displayValue={`${shapeDynamics.roundnessJitter}%`}
          onChange={(v) => setShapeDynamics({ roundnessJitter: v })}
        />
        <SelectRow
          label={t('brushPanel.control.label')}
          value={shapeDynamics.roundnessControl}
          options={baseControlOptions}
          onChange={(v) => setShapeDynamics({ roundnessControl: v as ControlSource })}
          disabled={disabled}
        />
        <SliderRow
          label={t('brushPanel.shapeDynamics.minimumRoundness')}
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
          <span>{t('brushPanel.shapeDynamics.flipXJitter')}</span>
        </label>
        <label className="flip-checkbox">
          <input
            type="checkbox"
            checked={shapeDynamics.flipYJitter}
            onChange={() => setShapeDynamics({ flipYJitter: !shapeDynamics.flipYJitter })}
            disabled={disabled}
          />
          <span>{t('brushPanel.shapeDynamics.flipYJitter')}</span>
        </label>
      </div>
    </div>
  );
}

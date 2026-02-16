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
import { SliderRow, SelectRow, SelectOption } from '../BrushPanelComponents';
import { useI18n } from '@/i18n';

export function ScatterSettings(): JSX.Element {
  const { t } = useI18n();
  const { scatter, setScatter, scatterEnabled } = useToolStore();

  const disabled = !scatterEnabled;
  const scatterControlOptions: SelectOption[] = [
    { value: 'off', label: t('brushPanel.control.off') },
    { value: 'fade', label: t('brushPanel.control.fade') },
    { value: 'penPressure', label: t('brushPanel.control.penPressure') },
    { value: 'penTilt', label: t('brushPanel.control.penTilt') },
    { value: 'rotation', label: t('brushPanel.control.rotation') },
  ];

  return (
    <div className="brush-panel-section">
      {/* Section header */}
      <div className="section-header-row">
        <h4>{t('brushPanel.tab.scattering')}</h4>
      </div>

      {/* Scatter Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label={t('brushPanel.scatter.scatter')}
          value={scatter.scatter}
          min={0}
          max={1000}
          displayValue={`${scatter.scatter}%`}
          onChange={(v) => setScatter({ scatter: v })}
        />
        <SelectRow
          label={t('brushPanel.control.label')}
          value={scatter.scatterControl}
          options={scatterControlOptions}
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
          <span>{t('brushPanel.scatter.bothAxes')}</span>
        </label>
      </div>

      {/* Count Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label={t('brushPanel.scatter.count')}
          value={scatter.count}
          min={1}
          max={16}
          displayValue={`${scatter.count}`}
          onChange={(v) => setScatter({ count: v })}
        />
        <SelectRow
          label={t('brushPanel.control.label')}
          value={scatter.countControl}
          options={scatterControlOptions}
          onChange={(v) => setScatter({ countControl: v as ControlSource })}
          disabled={disabled}
        />
        <SliderRow
          label={t('brushPanel.scatter.countJitter')}
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

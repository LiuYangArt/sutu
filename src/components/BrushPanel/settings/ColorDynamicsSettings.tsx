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
import { useI18n } from '@/i18n';

export function ColorDynamicsSettings(): JSX.Element {
  const { t } = useI18n();
  const { colorDynamics, setColorDynamics, colorDynamicsEnabled } = useToolStore();

  const disabled = !colorDynamicsEnabled;
  const applyPerTip = colorDynamics.applyPerTip !== false;
  const fbControlOptions: SelectOption[] = [
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
        <h4>{t('brushPanel.tab.colorDynamics')}</h4>
      </div>

      {/* Foreground/Background Jitter Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <div className="setting-checkbox-row">
          <label className={`flip-checkbox ${disabled ? 'disabled' : ''}`}>
            <input
              type="checkbox"
              checked={applyPerTip}
              onChange={(e) => setColorDynamics({ applyPerTip: e.target.checked })}
              disabled={disabled}
            />
            <span>{t('brushPanel.colorDynamics.applyPerTip')}</span>
          </label>
        </div>

        <SliderRow
          label={t('brushPanel.colorDynamics.foregroundBackgroundJitter')}
          value={colorDynamics.foregroundBackgroundJitter}
          min={0}
          max={100}
          displayValue={`${colorDynamics.foregroundBackgroundJitter}%`}
          onChange={(v) => setColorDynamics({ foregroundBackgroundJitter: v })}
        />
        <SelectRow
          label={t('brushPanel.control.label')}
          value={colorDynamics.foregroundBackgroundControl}
          options={fbControlOptions}
          onChange={(v) => setColorDynamics({ foregroundBackgroundControl: v as ControlSource })}
          disabled={disabled}
        />
      </div>

      {/* HSB Jitter Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label={t('brushPanel.colorDynamics.hueJitter')}
          value={colorDynamics.hueJitter}
          min={0}
          max={100}
          displayValue={`${colorDynamics.hueJitter}%`}
          onChange={(v) => setColorDynamics({ hueJitter: v })}
        />
        <SliderRow
          label={t('brushPanel.colorDynamics.saturationJitter')}
          value={colorDynamics.saturationJitter}
          min={0}
          max={100}
          displayValue={`${colorDynamics.saturationJitter}%`}
          onChange={(v) => setColorDynamics({ saturationJitter: v })}
        />
        <SliderRow
          label={t('brushPanel.colorDynamics.brightnessJitter')}
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
          label={t('brushPanel.colorDynamics.purity')}
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

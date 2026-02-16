/**
 * TransferSettings - Photoshop-compatible Transfer panel
 *
 * Controls how opacity and flow vary during a stroke:
 * - Opacity Jitter + Control + Minimum
 * - Flow Jitter + Control + Minimum
 */

import { useToolStore, ControlSource } from '@/stores/tool';
import { SliderRow, SelectRow, SelectOption } from '../BrushPanelComponents';
import { useI18n } from '@/i18n';

/** Reusable Jitter Group component for Opacity/Flow */
function JitterGroup({
  label,
  jitter,
  control,
  minimum,
  disabled,
  controlLabel,
  minimumLabel,
  jitterSuffix,
  controlOptions,
  onJitterChange,
  onControlChange,
  onMinimumChange,
}: {
  label: string;
  jitter: number;
  control: ControlSource;
  minimum: number;
  disabled: boolean;
  controlLabel: string;
  minimumLabel: string;
  jitterSuffix: string;
  controlOptions: SelectOption[];
  onJitterChange: (v: number) => void;
  onControlChange: (v: ControlSource) => void;
  onMinimumChange: (v: number) => void;
}): JSX.Element {
  return (
    <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
      <SliderRow
        label={`${label} ${jitterSuffix}`}
        value={jitter}
        min={0}
        max={100}
        displayValue={`${jitter}%`}
        onChange={onJitterChange}
      />
      <SelectRow
        label={controlLabel}
        value={control}
        options={controlOptions}
        onChange={(v) => onControlChange(v as ControlSource)}
        disabled={disabled}
      />
      <SliderRow
        label={minimumLabel}
        value={minimum}
        min={0}
        max={100}
        displayValue={`${minimum}%`}
        onChange={onMinimumChange}
        disabled={disabled || control === 'off'}
      />
    </div>
  );
}

export function TransferSettings(): JSX.Element {
  const { t } = useI18n();
  const { transfer, setTransfer, transferEnabled } = useToolStore();

  const disabled = !transferEnabled;
  const controlOptions: SelectOption[] = [
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
        <h4>{t('brushPanel.tab.transfer')}</h4>
      </div>

      {/* Opacity Jitter Group */}
      <JitterGroup
        label={t('toolbar.brush.opacity')}
        jitter={transfer.opacityJitter}
        control={transfer.opacityControl}
        minimum={transfer.minimumOpacity}
        disabled={disabled}
        controlLabel={t('brushPanel.control.label')}
        minimumLabel={t('brushPanel.transfer.minimum')}
        jitterSuffix={t('brushPanel.transfer.jitter')}
        controlOptions={controlOptions}
        onJitterChange={(v) => setTransfer({ opacityJitter: v })}
        onControlChange={(v) => setTransfer({ opacityControl: v })}
        onMinimumChange={(v) => setTransfer({ minimumOpacity: v })}
      />

      {/* Flow Jitter Group */}
      <JitterGroup
        label={t('toolbar.brush.flow')}
        jitter={transfer.flowJitter}
        control={transfer.flowControl}
        minimum={transfer.minimumFlow}
        disabled={disabled}
        controlLabel={t('brushPanel.control.label')}
        minimumLabel={t('brushPanel.transfer.minimum')}
        jitterSuffix={t('brushPanel.transfer.jitter')}
        controlOptions={controlOptions}
        onJitterChange={(v) => setTransfer({ flowJitter: v })}
        onControlChange={(v) => setTransfer({ flowControl: v })}
        onMinimumChange={(v) => setTransfer({ minimumFlow: v })}
      />
    </div>
  );
}

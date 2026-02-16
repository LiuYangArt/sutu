import { useI18n } from '@/i18n';

export function NoiseSettings(): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="brush-panel-section">
      <div className="section-header-row">
        <h4>{t('brushPanel.tab.noise')}</h4>
      </div>
    </div>
  );
}

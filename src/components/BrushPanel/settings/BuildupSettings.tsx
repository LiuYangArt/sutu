import { useI18n } from '@/i18n';

export function BuildupSettings(): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="brush-panel-section">
      <div className="section-header-row">
        <h4>{t('brushPanel.tab.buildUp')}</h4>
      </div>

      <div className="dynamics-group" style={{ gap: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
          {t('brushPanel.buildUp.description')}
        </div>
      </div>
    </div>
  );
}

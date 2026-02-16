// import { useToolStore } from '@/stores/tool';
import { useI18n } from '@/i18n';

export function WetEdgeSettings(): JSX.Element {
  const { t } = useI18n();
  // const { wetEdgeEnabled, toggleWetEdge } = useToolStore();

  return (
    <div className="brush-panel-section">
      <h4>{t('brushPanel.tab.wetEdges')}</h4>

      <div className="setting-row">
        <label className="checkbox-label">
          <span>{t('brushPanel.wetEdges.enableWetEdges')}</span>
        </label>
      </div>

      <p className="setting-description">{t('brushPanel.wetEdges.description')}</p>
    </div>
  );
}

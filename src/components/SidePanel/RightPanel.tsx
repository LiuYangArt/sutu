/**
 * Right Panel - Fixed position, contains Color and Layer sections
 */
import { ColorPanel } from '../ColorPanel';
import { LayerPanel } from '../LayerPanel';
import { useI18n } from '@/i18n';
import './SidePanel.css';

export function RightPanel() {
  const { t } = useI18n();
  return (
    <aside className="right-panel">
      <section className="panel-section color-section">
        <header className="section-header">
          <h3>{t('rightPanel.color')}</h3>
        </header>
        <div className="section-content">
          <ColorPanel />
        </div>
      </section>

      <div className="panel-divider" />

      <section className="panel-section layer-section">
        <header className="section-header">
          <h3>{t('rightPanel.layers')}</h3>
        </header>
        <div className="section-content layer-content">
          <LayerPanel />
        </div>
      </section>
    </aside>
  );
}

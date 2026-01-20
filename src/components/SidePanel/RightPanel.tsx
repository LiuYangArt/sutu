/**
 * Right Panel - Fixed position, contains Color and Layer sections
 */
import { ColorPanel } from '../ColorPanel';
import { LayerPanel } from '../LayerPanel';
import './SidePanel.css';

export function RightPanel() {
  return (
    <aside className="right-panel">
      <section className="panel-section color-section">
        <header className="section-header">
          <h3>COLOR</h3>
        </header>
        <div className="section-content">
          <ColorPanel />
        </div>
      </section>

      <div className="panel-divider" />

      <section className="panel-section layer-section">
        <header className="section-header">
          <h3>LAYERS</h3>
        </header>
        <div className="section-content layer-content">
          <LayerPanel />
        </div>
      </section>
    </aside>
  );
}

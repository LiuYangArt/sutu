/**
 * Right Panel - Fixed position, contains Color and Layer sections
 */
import { Plus, Eraser } from 'lucide-react';
import { ColorPanel } from '../ColorPanel';
import { LayerPanel } from '../LayerPanel';
import { useDocumentStore } from '@/stores/document';
import { clearActiveLayer } from '@/utils/canvasCommands';
import './SidePanel.css';

export function RightPanel() {
  const layers = useDocumentStore((s) => s.layers);
  const activeLayerId = useDocumentStore((s) => s.activeLayerId);
  const addLayer = useDocumentStore((s) => s.addLayer);

  const handleAddLayer = () => {
    addLayer({ name: `Layer ${layers.length + 1}`, type: 'raster' });
  };

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
          <div className="section-actions">
            <button
              className="section-action-btn"
              onClick={clearActiveLayer}
              title="Clear Layer Content"
              disabled={!activeLayerId}
            >
              <Eraser size={14} />
            </button>
            <button className="section-action-btn" onClick={handleAddLayer} title="Add Layer">
              <Plus size={14} />
            </button>
          </div>
        </header>
        <div className="section-content layer-content">
          <LayerPanel />
        </div>
      </section>
    </aside>
  );
}

import { useDocumentStore } from '@/stores/document';
import './LayerPanel.css';

export function LayerPanel() {
  const { layers, activeLayerId, setActiveLayer, addLayer, removeLayer, toggleLayerVisibility } =
    useDocumentStore((s) => ({
      layers: s.layers,
      activeLayerId: s.activeLayerId,
      setActiveLayer: s.setActiveLayer,
      addLayer: s.addLayer,
      removeLayer: s.removeLayer,
      toggleLayerVisibility: s.toggleLayerVisibility,
    }));

  return (
    <aside className="layer-panel">
      <header className="layer-panel-header">
        <h3>Layers</h3>
        <button
          className="add-layer-btn"
          data-testid="add-layer-btn"
          onClick={() => addLayer({ name: `Layer ${layers.length + 1}`, type: 'raster' })}
          title="Add Layer"
        >
          +
        </button>
      </header>

      <div className="layer-list">
        {layers.length === 0 ? (
          <div className="layer-empty">No layers</div>
        ) : (
          [...layers].reverse().map((layer) => (
            <div
              key={layer.id}
              className={`layer-item ${activeLayerId === layer.id ? 'active' : ''}`}
              data-testid="layer-item"
              onClick={() => setActiveLayer(layer.id)}
            >
              <button
                className={`visibility-toggle ${layer.visible ? 'visible' : 'hidden'}`}
                data-testid="layer-visibility-toggle"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleLayerVisibility(layer.id);
                }}
                title={layer.visible ? 'Hide Layer' : 'Show Layer'}
              >
                {layer.visible ? '👁️' : '👁️‍🗨️'}
              </button>

              <div className="layer-thumbnail" />

              <span className="layer-name" data-testid="layer-name">
                {layer.name}
              </span>

              <button
                className="delete-layer-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  removeLayer(layer.id);
                }}
                title="Delete Layer"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      <footer className="layer-panel-footer">
        <select className="blend-mode-select" defaultValue="normal">
          <option value="normal">Normal</option>
          <option value="multiply">Multiply</option>
          <option value="screen">Screen</option>
          <option value="overlay">Overlay</option>
          <option value="darken">Darken</option>
          <option value="lighten">Lighten</option>
        </select>

        <label className="opacity-control">
          <span>Opacity:</span>
          <input type="range" min="0" max="100" defaultValue="100" />
          <span>100%</span>
        </label>
      </footer>
    </aside>
  );
}

import { Eye, EyeOff, Plus, Trash2, Lock, Unlock } from 'lucide-react';
import { useDocumentStore, BlendMode } from '@/stores/document';
import './LayerPanel.css';

const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'soft-light', label: 'Soft Light' },
];

export function LayerPanel() {
  const {
    layers,
    activeLayerId,
    setActiveLayer,
    addLayer,
    removeLayer,
    toggleLayerVisibility,
    setLayerOpacity,
    setLayerBlendMode,
    toggleLayerLock,
  } = useDocumentStore((s) => ({
    layers: s.layers,
    activeLayerId: s.activeLayerId,
    setActiveLayer: s.setActiveLayer,
    addLayer: s.addLayer,
    removeLayer: s.removeLayer,
    toggleLayerVisibility: s.toggleLayerVisibility,
    setLayerOpacity: s.setLayerOpacity,
    setLayerBlendMode: s.setLayerBlendMode,
    toggleLayerLock: s.toggleLayerLock,
  }));

  const activeLayer = layers.find((l) => l.id === activeLayerId);

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
          <Plus size={16} strokeWidth={2} />
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
                {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
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
                <Trash2 size={14} />
              </button>

              <button
                className={`lock-toggle ${layer.locked ? 'locked' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleLayerLock(layer.id);
                }}
                title={layer.locked ? 'Unlock Layer' : 'Lock Layer'}
              >
                {layer.locked ? <Lock size={14} /> : <Unlock size={14} />}
              </button>
            </div>
          ))
        )}
      </div>

      <footer className="layer-panel-footer">
        <select
          className="blend-mode-select"
          value={activeLayer?.blendMode ?? 'normal'}
          onChange={(e) => {
            if (activeLayerId) {
              setLayerBlendMode(activeLayerId, e.target.value as BlendMode);
            }
          }}
          disabled={!activeLayer}
        >
          {BLEND_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>

        <label className="opacity-control">
          <span>Opacity:</span>
          <input
            type="range"
            min="0"
            max="100"
            value={activeLayer?.opacity ?? 100}
            onChange={(e) => {
              if (activeLayerId) {
                setLayerOpacity(activeLayerId, Number(e.target.value));
              }
            }}
            disabled={!activeLayer}
          />
          <span>{activeLayer?.opacity ?? 100}%</span>
        </label>
      </footer>
    </aside>
  );
}

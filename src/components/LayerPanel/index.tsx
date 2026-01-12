import { useState } from 'react';
import { Eye, EyeOff, Plus, Trash2, Lock, Unlock, GripVertical, Eraser } from 'lucide-react';
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
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

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
    moveLayer,
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
    moveLayer: s.moveLayer,
  }));

  const activeLayer = layers.find((l) => l.id === activeLayerId);

  // Reversed layers for display (top layer first)
  const displayLayers = [...layers].reverse();

  const handleDragStart = (e: React.DragEvent, layerId: string) => {
    setDraggedId(layerId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', layerId);
  };

  const handleDragOver = (e: React.DragEvent, layerId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (layerId !== draggedId) {
      setDropTargetId(layerId);
    }
  };

  const handleDragLeave = () => {
    setDropTargetId(null);
  };

  const handleDrop = (e: React.DragEvent, targetLayerId: string) => {
    e.preventDefault();
    setDropTargetId(null);
    setDraggedId(null);

    if (!draggedId || draggedId === targetLayerId) return;

    // Find indices in the original (non-reversed) array
    const fromIndex = layers.findIndex((l) => l.id === draggedId);
    const toIndex = layers.findIndex((l) => l.id === targetLayerId);

    if (fromIndex !== -1 && toIndex !== -1) {
      moveLayer(draggedId, toIndex);
    }
  };

  const handleDragEnd = () => {
    setDraggedId(null);
    setDropTargetId(null);
  };

  const handleClearLayer = () => {
    const win = window as Window & { __canvasClearLayer?: () => void };
    if (win.__canvasClearLayer) {
      win.__canvasClearLayer();
    }
  };

  return (
    <aside className="layer-panel">
      <header className="layer-panel-header">
        <h3>Layers</h3>
        <div className="layer-panel-actions">
          <button
            className="clear-layer-btn"
            data-testid="clear-layer-btn"
            onClick={handleClearLayer}
            title="Clear Layer Content"
            disabled={!activeLayerId}
          >
            <Eraser size={16} strokeWidth={2} />
          </button>
          <button
            className="add-layer-btn"
            data-testid="add-layer-btn"
            onClick={() => addLayer({ name: `Layer ${layers.length + 1}`, type: 'raster' })}
            title="Add Layer"
          >
            <Plus size={16} strokeWidth={2} />
          </button>
        </div>
      </header>

      <div className="layer-list">
        {layers.length === 0 ? (
          <div className="layer-empty">No layers</div>
        ) : (
          displayLayers.map((layer) => (
            <div
              key={layer.id}
              className={`layer-item ${activeLayerId === layer.id ? 'active' : ''} ${draggedId === layer.id ? 'dragging' : ''} ${dropTargetId === layer.id ? 'drop-target' : ''}`}
              data-testid="layer-item"
              draggable
              onDragStart={(e) => handleDragStart(e, layer.id)}
              onDragOver={(e) => handleDragOver(e, layer.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, layer.id)}
              onDragEnd={handleDragEnd}
              onClick={() => setActiveLayer(layer.id)}
            >
              <div className="drag-handle">
                <GripVertical size={14} />
              </div>

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

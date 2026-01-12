import { useState, useEffect, useCallback } from 'react';
import { Eye, EyeOff, Plus, Trash2, Lock, Unlock, GripVertical, Eraser, Copy } from 'lucide-react';
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
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  layerId: string | null;
}

export function LayerPanel(): JSX.Element {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    layerId: null,
  });

  const {
    layers,
    activeLayerId,
    setActiveLayer,
    addLayer,
    removeLayer,
    duplicateLayer,
    toggleLayerVisibility,
    setLayerOpacity,
    setLayerBlendMode,
    toggleLayerLock,
    moveLayer,
    width,
    height,
  } = useDocumentStore((s) => ({
    layers: s.layers,
    activeLayerId: s.activeLayerId,
    setActiveLayer: s.setActiveLayer,
    addLayer: s.addLayer,
    removeLayer: s.removeLayer,
    duplicateLayer: s.duplicateLayer,
    toggleLayerVisibility: s.toggleLayerVisibility,
    setLayerOpacity: s.setLayerOpacity,
    setLayerBlendMode: s.setLayerBlendMode,
    toggleLayerLock: s.toggleLayerLock,
    moveLayer: s.moveLayer,
    width: s.width,
    height: s.height,
  }));

  // Close context menu when clicking outside
  useEffect(() => {
    function handleClickOutside() {
      if (contextMenu.visible) {
        setContextMenu((prev) => ({ ...prev, visible: false }));
      }
    }
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [contextMenu.visible]);

  const handleContextMenu = useCallback((e: React.MouseEvent, layerId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      layerId,
    });
  }, []);

  const handleDuplicateLayer = useCallback(() => {
    if (contextMenu.layerId) {
      const newLayerId = duplicateLayer(contextMenu.layerId);
      // Trigger canvas to copy layer content
      if (newLayerId) {
        const win = window as Window & {
          __canvasDuplicateLayer?: (from: string, to: string) => void;
        };
        if (win.__canvasDuplicateLayer) {
          win.__canvasDuplicateLayer(contextMenu.layerId, newLayerId);
        }
      }
    }
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, [contextMenu.layerId, duplicateLayer]);

  const handleDeleteLayer = useCallback(() => {
    if (contextMenu.layerId) {
      removeLayer(contextMenu.layerId);
    }
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, [contextMenu.layerId, removeLayer]);

  const activeLayer = layers.find((l) => l.id === activeLayerId);
  const displayLayers = [...layers].reverse();
  const { width: thumbWidth, height: thumbHeight } = calculateThumbnailDimensions(width, height);

  function handleDragStart(e: React.DragEvent, layerId: string): void {
    setDraggedId(layerId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', layerId);
  }

  function handleDragOver(e: React.DragEvent, layerId: string): void {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (layerId !== draggedId) {
      setDropTargetId(layerId);
    }
  }

  function handleDragLeave(): void {
    setDropTargetId(null);
  }

  function handleDrop(e: React.DragEvent, targetLayerId: string): void {
    e.preventDefault();
    setDropTargetId(null);
    setDraggedId(null);

    if (!draggedId || draggedId === targetLayerId) return;

    const fromIndex = layers.findIndex((l) => l.id === draggedId);
    const toIndex = layers.findIndex((l) => l.id === targetLayerId);

    if (fromIndex !== -1 && toIndex !== -1) {
      moveLayer(draggedId, toIndex);
    }
  }

  function handleDragEnd(): void {
    setDraggedId(null);
    setDropTargetId(null);
  }

  function handleClearLayer(): void {
    const win = window as Window & { __canvasClearLayer?: () => void };
    if (win.__canvasClearLayer) {
      win.__canvasClearLayer();
    }
  }

  function handleAddLayer(): void {
    addLayer({ name: `Layer ${layers.length + 1}`, type: 'raster' });
  }

  // Event handlers wrappers to prevent inline arrow function creation in render loop where possible
  // (Though for mapped items, inline is often inevitable without sub-components, keeping simple here)

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
            onClick={handleAddLayer}
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
              className={`layer-item ${activeLayerId === layer.id ? 'active' : ''} ${
                draggedId === layer.id ? 'dragging' : ''
              } ${dropTargetId === layer.id ? 'drop-target' : ''}`}
              data-testid="layer-item"
              draggable
              onDragStart={(e) => handleDragStart(e, layer.id)}
              onDragOver={(e) => handleDragOver(e, layer.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, layer.id)}
              onDragEnd={handleDragEnd}
              onClick={() => setActiveLayer(layer.id)}
              onContextMenu={(e) => handleContextMenu(e, layer.id)}
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

              <div
                className="layer-thumbnail"
                style={{
                  width: thumbWidth,
                  height: thumbHeight,
                }}
              >
                {layer.thumbnail && (
                  <img src={layer.thumbnail} alt={layer.name} draggable={false} />
                )}
              </div>

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

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          className="layer-context-menu"
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="context-menu-item" onClick={handleDuplicateLayer}>
            <Copy size={14} />
            <span>Duplicate Layer</span>
          </button>
          <button className="context-menu-item danger" onClick={handleDeleteLayer}>
            <Trash2 size={14} />
            <span>Delete Layer</span>
          </button>
        </div>
      )}
    </aside>
  );
}

const MAX_THUMB_HEIGHT = 32;
const MAX_THUMB_WIDTH = 80;

function calculateThumbnailDimensions(
  width: number,
  height: number
): { width: number; height: number } {
  const aspectRatio = width / height;
  const thumbHeight = MAX_THUMB_HEIGHT;
  const thumbWidth = Math.max(
    MAX_THUMB_HEIGHT,
    Math.min(MAX_THUMB_HEIGHT * aspectRatio, MAX_THUMB_WIDTH)
  );

  return { width: thumbWidth, height: thumbHeight };
}

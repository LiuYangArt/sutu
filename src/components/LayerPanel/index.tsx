import { useState, useEffect, useCallback, memo, useRef } from 'react';
import {
  Eye,
  EyeOff,
  Plus,
  Trash2,
  Lock,
  Unlock,
  GripVertical,
  Eraser,
  Copy,
  FolderPlus,
} from 'lucide-react';
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
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
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
    renameLayer,
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
    renameLayer: s.renameLayer,
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

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
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
    closeContextMenu();
  }, [contextMenu.layerId, duplicateLayer, closeContextMenu]);

  // Helper to remove layer via Canvas interface (saves history)
  const safeRemoveLayer = useCallback(
    (id: string) => {
      const win = window as Window & { __canvasRemoveLayer?: (id: string) => void };
      if (win.__canvasRemoveLayer) {
        win.__canvasRemoveLayer(id);
      } else {
        removeLayer(id);
      }
    },
    [removeLayer]
  );

  const handleDeleteLayer = useCallback(() => {
    if (contextMenu.layerId) safeRemoveLayer(contextMenu.layerId);
    closeContextMenu();
  }, [contextMenu.layerId, safeRemoveLayer, closeContextMenu]);

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

  function handleAddGroup(): void {
    // TODO: Implement group/folder layer type
    addLayer({ name: `Group ${layers.length + 1}`, type: 'raster' });
  }

  // Handle rename completion
  const handleRenameComplete = useCallback(
    (id: string, newName: string) => {
      if (newName.trim()) {
        renameLayer(id, newName.trim());
      }
      setEditingLayerId(null);
    },
    [renameLayer]
  );

  // Delete active layer from toolbar
  const handleDeleteActiveLayer = useCallback(() => {
    if (activeLayerId) {
      safeRemoveLayer(activeLayerId);
    }
  }, [activeLayerId, safeRemoveLayer]);

  // Toggle lock on active layer
  const handleToggleActiveLock = useCallback(() => {
    if (activeLayerId) {
      toggleLayerLock(activeLayerId);
    }
  }, [activeLayerId, toggleLayerLock]);

  // F2 shortcut to rename active layer
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'F2' && activeLayerId && !editingLayerId) {
        e.preventDefault();
        setEditingLayerId(activeLayerId);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeLayerId, editingLayerId]);

  return (
    <aside className="layer-panel">
      <div
        className="layer-list"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
      >
        {layers.length === 0 ? (
          <div className="layer-empty">No layers</div>
        ) : (
          displayLayers.map((layer) => (
            <LayerItem
              key={layer.id}
              layer={layer}
              isActive={activeLayerId === layer.id}
              isEditing={editingLayerId === layer.id}
              isDragging={draggedId === layer.id}
              isDropTarget={dropTargetId === layer.id}
              thumbDimensions={{ width: thumbWidth, height: thumbHeight }}
              onActivate={setActiveLayer}
              onToggleVisibility={toggleLayerVisibility}
              onContextMenu={handleContextMenu}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onDragLeave={handleDragLeave}
              onDragEnd={handleDragEnd}
              onRenameComplete={handleRenameComplete}
              onRenameCancel={() => setEditingLayerId(null)}
              onStartEditing={setEditingLayerId}
            />
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

        <div className="layer-toolbar">
          <button className="toolbar-btn" onClick={handleAddLayer} title="New Layer">
            <Plus size={16} />
          </button>
          <button className="toolbar-btn" onClick={handleAddGroup} title="New Group">
            <FolderPlus size={16} />
          </button>
          <button
            className="toolbar-btn"
            onClick={handleClearLayer}
            title="Clear Layer"
            disabled={!activeLayerId}
          >
            <Eraser size={16} />
          </button>
          <button
            className={`toolbar-btn ${activeLayer?.locked ? 'active' : ''}`}
            onClick={handleToggleActiveLock}
            title={activeLayer?.locked ? 'Unlock Layer' : 'Lock Layer'}
            disabled={!activeLayerId}
          >
            {activeLayer?.locked ? <Lock size={16} /> : <Unlock size={16} />}
          </button>
          <button
            className="toolbar-btn danger"
            onClick={handleDeleteActiveLayer}
            title="Delete Layer"
            disabled={!activeLayerId || layers.length <= 1}
          >
            <Trash2 size={16} />
          </button>
        </div>
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

interface LayerItemProps {
  layer: {
    id: string;
    name: string;
    visible: boolean;
    locked: boolean;
    thumbnail?: string;
  };
  isActive: boolean;
  isEditing: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  thumbDimensions: { width: number; height: number };
  onActivate: (id: string) => void;
  onToggleVisibility: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDrop: (e: React.DragEvent, id: string) => void;
  onDragLeave: () => void;
  onDragEnd: () => void;
  onRenameComplete: (id: string, newName: string) => void;
  onRenameCancel: () => void;
  onStartEditing: (id: string) => void;
}

const LayerItem = memo(function LayerItem({
  layer,
  isActive,
  isEditing,
  isDragging,
  isDropTarget,
  thumbDimensions,
  onActivate,
  onToggleVisibility,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragLeave,
  onDragEnd,
  onRenameComplete,
  onRenameCancel,
  onStartEditing,
}: LayerItemProps) {
  // Track if drag started from handle
  const dragFromHandleRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editValue, setEditValue] = useState(layer.name);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      setEditValue(layer.name);
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing, layer.name]);

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onRenameComplete(layer.id, editValue);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onRenameCancel();
    }
  };

  const handleInputBlur = () => {
    onRenameComplete(layer.id, editValue);
  };

  return (
    <div
      className={`layer-item ${isActive ? 'active' : ''} ${
        isDragging ? 'dragging' : ''
      } ${isDropTarget ? 'drop-target' : ''} ${layer.locked ? 'locked' : ''}`}
      data-testid="layer-item"
      draggable
      onMouseDown={(e) => {
        // Record if mousedown happened on the drag handle
        const target = e.target as HTMLElement;
        dragFromHandleRef.current = !!target.closest('.drag-handle');
      }}
      onDragStart={(e) => {
        // Only allow drag if mousedown was on the handle
        if (!dragFromHandleRef.current) {
          e.preventDefault();
          return;
        }
        onDragStart(e, layer.id);
      }}
      onDragOver={(e) => onDragOver(e, layer.id)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, layer.id)}
      onDragEnd={onDragEnd}
      onClick={() => onActivate(layer.id)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartEditing(layer.id);
      }}
      onContextMenu={(e) => onContextMenu(e, layer.id)}
    >
      <div className="drag-handle">
        <GripVertical size={14} />
      </div>

      <button
        className={`visibility-toggle ${layer.visible ? 'visible' : 'hidden'}`}
        data-testid="layer-visibility-toggle"
        draggable={false}
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisibility(layer.id);
        }}
        title={layer.visible ? 'Hide Layer' : 'Show Layer'}
      >
        {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>

      <div
        className="layer-thumbnail"
        draggable={false}
        style={{
          width: thumbDimensions.width,
          height: thumbDimensions.height,
        }}
      >
        {layer.thumbnail && <img src={layer.thumbnail} alt={layer.name} draggable={false} />}
      </div>

      {isEditing ? (
        <input
          ref={inputRef}
          className="layer-name-input"
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleInputKeyDown}
          onBlur={handleInputBlur}
          onClick={(e) => e.stopPropagation()}
          draggable={false}
        />
      ) : (
        <span className="layer-name" data-testid="layer-name" draggable={false}>
          {layer.name}
        </span>
      )}

      {layer.locked && <Lock size={12} className="lock-indicator" />}
    </div>
  );
});

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

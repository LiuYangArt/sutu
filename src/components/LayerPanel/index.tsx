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
import { useToastStore } from '@/stores/toast';
import './LayerPanel.css';

interface BlendModeOption {
  value: BlendMode;
  label: string;
}

const BLEND_MODE_GROUPS: ReadonlyArray<ReadonlyArray<BlendModeOption>> = [
  [
    { value: 'normal', label: 'Normal' },
    { value: 'dissolve', label: 'Dissolve' },
  ],
  [
    { value: 'darken', label: 'Darken' },
    { value: 'multiply', label: 'Multiply' },
    { value: 'color-burn', label: 'Color Burn' },
    { value: 'linear-burn', label: 'Linear Burn' },
    { value: 'darker-color', label: 'Darker Color' },
  ],
  [
    { value: 'lighten', label: 'Lighten' },
    { value: 'screen', label: 'Screen' },
    { value: 'color-dodge', label: 'Color Dodge' },
    { value: 'linear-dodge', label: 'Linear Dodge (Add)' },
    { value: 'lighter-color', label: 'Lighter Color' },
  ],
  [
    { value: 'overlay', label: 'Overlay' },
    { value: 'soft-light', label: 'Soft Light' },
    { value: 'hard-light', label: 'Hard Light' },
    { value: 'vivid-light', label: 'Vivid Light' },
    { value: 'linear-light', label: 'Linear Light' },
    { value: 'pin-light', label: 'Pin Light' },
    { value: 'hard-mix', label: 'Hard Mix' },
  ],
  [
    { value: 'difference', label: 'Difference' },
    { value: 'exclusion', label: 'Exclusion' },
    { value: 'subtract', label: 'Subtract' },
    { value: 'divide', label: 'Divide' },
  ],
  [
    { value: 'hue', label: 'Hue' },
    { value: 'saturation', label: 'Saturation' },
    { value: 'color', label: 'Color' },
    { value: 'luminosity', label: 'Luminosity' },
  ],
];

type BlendModeMenuItem =
  | { kind: 'mode'; value: BlendMode; label: string }
  | { kind: 'separator'; key: string };

function buildBlendModeMenuItems(
  groups: ReadonlyArray<ReadonlyArray<BlendModeOption>>
): BlendModeMenuItem[] {
  const items: BlendModeMenuItem[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    if (!group) continue;
    for (const mode of group) {
      items.push({ kind: 'mode', ...mode });
    }
    if (i < groups.length - 1) {
      items.push({ kind: 'separator', key: `sep-${i}` });
    }
  }
  return items;
}

function buildBlendModeLabelMap(
  groups: ReadonlyArray<ReadonlyArray<BlendModeOption>>
): Map<BlendMode, string> {
  const map = new Map<BlendMode, string>();
  for (const group of groups) {
    for (const mode of group) {
      map.set(mode.value, mode.label);
    }
  }
  return map;
}

function getBlendModeLabel(mode: BlendMode): string {
  return BLEND_MODE_LABEL_MAP.get(mode) ?? 'Normal';
}

const BLEND_MODE_MENU_ITEMS: BlendModeMenuItem[] = buildBlendModeMenuItems(BLEND_MODE_GROUPS);
const BLEND_MODE_LABEL_MAP = buildBlendModeLabelMap(BLEND_MODE_GROUPS);

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  layerId: string | null;
}

export function LayerPanel(): JSX.Element {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [draggedIds, setDraggedIds] = useState<string[]>([]);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [blendMenuOpen, setBlendMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    layerId: null,
  });
  const blendMenuRef = useRef<HTMLDivElement | null>(null);

  const {
    layers,
    activeLayerId,
    selectedLayerIds,
    layerSelectionAnchorId,
    setActiveLayer,
    setLayerSelection,
    addLayer,
    removeLayer,
    duplicateLayer,
    toggleLayerVisibility,
    setLayerOpacity,
    setLayerBlendMode,
    toggleLayerLock,
    renameLayer,
    moveLayer,
    moveLayers,
    width,
    height,
  } = useDocumentStore((s) => ({
    layers: s.layers,
    activeLayerId: s.activeLayerId,
    selectedLayerIds: s.selectedLayerIds,
    layerSelectionAnchorId: s.layerSelectionAnchorId,
    setActiveLayer: s.setActiveLayer,
    setLayerSelection: s.setLayerSelection,
    addLayer: s.addLayer,
    removeLayer: s.removeLayer,
    duplicateLayer: s.duplicateLayer,
    toggleLayerVisibility: s.toggleLayerVisibility,
    setLayerOpacity: s.setLayerOpacity,
    setLayerBlendMode: s.setLayerBlendMode,
    toggleLayerLock: s.toggleLayerLock,
    renameLayer: s.renameLayer,
    moveLayer: s.moveLayer,
    moveLayers: s.moveLayers,
    width: s.width,
    height: s.height,
  }));
  const pushToast = useToastStore((s) => s.pushToast);
  const selectedLayerIdSet = new Set(selectedLayerIds);
  const activeLayer = layers.find((l) => l.id === activeLayerId);
  const activeBlendMode = activeLayer?.blendMode ?? 'normal';
  const activeBlendModeLabel = getBlendModeLabel(activeBlendMode);
  const displayLayers = [...layers].reverse();
  const displayLayerIds = displayLayers.map((layer) => layer.id);
  const { width: thumbWidth, height: thumbHeight } = calculateThumbnailDimensions(width, height);

  const applyLayerSelection = useCallback(
    (nextSelectedIds: string[], nextActiveId?: string | null, nextAnchorId?: string | null) => {
      setLayerSelection(nextSelectedIds, nextActiveId, nextAnchorId);
    },
    [setLayerSelection]
  );

  // Close context menu when clicking outside
  useEffect(() => {
    if (!contextMenu.visible) return;
    function handleClickOutside() {
      setContextMenu((prev) => ({ ...prev, visible: false }));
    }
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [contextMenu.visible]);

  // Close blend mode dropdown when clicking outside
  useEffect(() => {
    if (!blendMenuOpen) return;
    function handlePointerDown(e: MouseEvent) {
      if (blendMenuRef.current && !blendMenuRef.current.contains(e.target as Node)) {
        setBlendMenuOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setBlendMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [blendMenuOpen]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, layerId: string) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selectedLayerIdSet.has(layerId)) {
        applyLayerSelection([layerId], layerId, layerId);
      }
      setContextMenu({
        visible: true,
        x: e.clientX,
        y: e.clientY,
        layerId,
      });
    },
    [applyLayerSelection, selectedLayerIdSet]
  );

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

  const safeRemoveLayers = useCallback(
    (ids: string[]) => {
      const uniqueIds = Array.from(new Set(ids));
      if (uniqueIds.length === 0) return;
      const win = window as Window & {
        __canvasRemoveLayers?: (layerIds: string[]) => number;
      };
      if (win.__canvasRemoveLayers) {
        win.__canvasRemoveLayers(uniqueIds);
        return;
      }
      for (const id of uniqueIds) {
        safeRemoveLayer(id);
      }
    },
    [safeRemoveLayer]
  );

  const safeMergeSelectedLayers = useCallback((ids: string[]) => {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length < 2) return;
    const win = window as Window & {
      __canvasMergeSelectedLayers?: (layerIds?: string[]) => number;
    };
    win.__canvasMergeSelectedLayers?.(uniqueIds);
  }, []);

  const handleDeleteLayer = useCallback(() => {
    if (!contextMenu.layerId) {
      closeContextMenu();
      return;
    }
    if (selectedLayerIdSet.has(contextMenu.layerId) && selectedLayerIds.length > 1) {
      safeRemoveLayers(selectedLayerIds);
    } else {
      safeRemoveLayer(contextMenu.layerId);
    }
    closeContextMenu();
  }, [
    closeContextMenu,
    contextMenu.layerId,
    safeRemoveLayer,
    safeRemoveLayers,
    selectedLayerIdSet,
    selectedLayerIds,
  ]);

  const handleMergeLayerSelection = useCallback(() => {
    if (selectedLayerIds.length > 1) {
      safeMergeSelectedLayers(selectedLayerIds);
    }
    closeContextMenu();
  }, [closeContextMenu, safeMergeSelectedLayers, selectedLayerIds]);

  function handleDragStart(e: React.DragEvent, layerId: string): void {
    const idsToDrag =
      selectedLayerIdSet.has(layerId) && selectedLayerIds.length > 1
        ? layers.filter((layer) => selectedLayerIdSet.has(layer.id)).map((layer) => layer.id)
        : [layerId];
    setDraggedId(layerId);
    setDraggedIds(idsToDrag);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify(idsToDrag));
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
    const draggedIdsSnapshot = draggedIds.length > 0 ? draggedIds : draggedId ? [draggedId] : [];
    setDraggedId(null);
    setDraggedIds([]);

    if (draggedIdsSnapshot.length === 0) return;
    if (draggedIdsSnapshot.includes(targetLayerId) && draggedIdsSnapshot.length > 1) return;

    const primaryDraggedId = draggedIdsSnapshot[0];
    if (!primaryDraggedId) return;
    const fromIndex = layers.findIndex((l) => l.id === primaryDraggedId);
    const toIndex = layers.findIndex((l) => l.id === targetLayerId);

    if (fromIndex !== -1 && toIndex !== -1) {
      if (draggedIdsSnapshot.length > 1) {
        moveLayers(draggedIdsSnapshot, toIndex);
      } else {
        moveLayer(primaryDraggedId, toIndex);
      }
    }
  }

  function handleDragEnd(): void {
    setDraggedId(null);
    setDraggedIds([]);
    setDropTargetId(null);
  }

  const handleLayerActivate = useCallback(
    (layerId: string, e: React.MouseEvent) => {
      const withShift = e.shiftKey;
      const withCtrl = e.ctrlKey || e.metaKey;

      if (withShift) {
        const anchorId = layerSelectionAnchorId ?? activeLayerId ?? layerId;
        const anchorIndex = displayLayerIds.indexOf(anchorId);
        const targetIndex = displayLayerIds.indexOf(layerId);
        if (anchorIndex >= 0 && targetIndex >= 0) {
          const start = Math.min(anchorIndex, targetIndex);
          const end = Math.max(anchorIndex, targetIndex);
          const rangeIds = displayLayerIds.slice(start, end + 1);
          applyLayerSelection(rangeIds, layerId, anchorId);
          return;
        }
      }

      if (withCtrl) {
        const next = new Set(selectedLayerIds);
        if (next.has(layerId)) {
          next.delete(layerId);
        } else {
          next.add(layerId);
        }
        const nextIds = Array.from(next);
        const nextActive =
          nextIds.includes(activeLayerId ?? '') || nextIds.length === 0 ? activeLayerId : layerId;
        const nextAnchor =
          layerSelectionAnchorId && nextIds.includes(layerSelectionAnchorId)
            ? layerSelectionAnchorId
            : layerId;
        applyLayerSelection(nextIds, nextActive, nextAnchor);
        return;
      }

      setActiveLayer(layerId);
    },
    [
      activeLayerId,
      applyLayerSelection,
      displayLayerIds,
      layerSelectionAnchorId,
      selectedLayerIds,
      setActiveLayer,
    ]
  );

  const applyBatchLayerOpacity = useCallback(
    (opacity: number) => {
      const targetIds =
        selectedLayerIds.length > 1 ? selectedLayerIds : activeLayerId ? [activeLayerId] : [];
      if (targetIds.length === 0) return;

      if (targetIds.length <= 1) {
        if (activeLayerId) {
          setLayerOpacity(activeLayerId, opacity);
        }
        return;
      }

      let lockedSkipped = 0;
      let backgroundSkipped = 0;
      let applied = 0;
      for (const layerId of targetIds) {
        const layer = layers.find((item) => item.id === layerId);
        if (!layer) continue;
        if (layer.locked) {
          lockedSkipped += 1;
          continue;
        }
        if (layer.isBackground) {
          backgroundSkipped += 1;
          continue;
        }
        setLayerOpacity(layerId, opacity);
        applied += 1;
      }
      if (applied > 0 && (lockedSkipped > 0 || backgroundSkipped > 0)) {
        pushToast(`Skipped ${lockedSkipped} locked + ${backgroundSkipped} background layer(s).`, {
          variant: 'info',
        });
      }
    },
    [activeLayerId, layers, pushToast, selectedLayerIds, setLayerOpacity]
  );

  const applyBatchLayerBlendMode = useCallback(
    (blendMode: BlendMode) => {
      const targetIds =
        selectedLayerIds.length > 1 ? selectedLayerIds : activeLayerId ? [activeLayerId] : [];
      if (targetIds.length === 0) return;

      if (targetIds.length <= 1) {
        if (activeLayerId) {
          setLayerBlendMode(activeLayerId, blendMode);
        }
        return;
      }

      let lockedSkipped = 0;
      let backgroundSkipped = 0;
      let applied = 0;
      for (const layerId of targetIds) {
        const layer = layers.find((item) => item.id === layerId);
        if (!layer) continue;
        if (layer.locked) {
          lockedSkipped += 1;
          continue;
        }
        if (layer.isBackground) {
          backgroundSkipped += 1;
          continue;
        }
        setLayerBlendMode(layerId, blendMode);
        applied += 1;
      }
      if (applied > 0 && (lockedSkipped > 0 || backgroundSkipped > 0)) {
        pushToast(`Skipped ${lockedSkipped} locked + ${backgroundSkipped} background layer(s).`, {
          variant: 'info',
        });
      }
    },
    [activeLayerId, layers, pushToast, selectedLayerIds, setLayerBlendMode]
  );

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
    if (selectedLayerIds.length > 1) {
      safeRemoveLayers(selectedLayerIds);
      return;
    }
    if (activeLayerId) {
      safeRemoveLayer(activeLayerId);
    }
  }, [activeLayerId, safeRemoveLayer, safeRemoveLayers, selectedLayerIds]);

  // Toggle lock on active layer
  const handleToggleActiveLock = useCallback(() => {
    if (activeLayerId) {
      toggleLayerLock(activeLayerId);
    }
  }, [activeLayerId, toggleLayerLock]);

  // F2 shortcut to rename active layer
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'F2' || editingLayerId) return;
      if (selectedLayerIds.length > 1) {
        e.preventDefault();
        const base = window.prompt('输入批量重命名基名', 'newname');
        const trimmedBase = base?.trim() ?? '';
        if (!trimmedBase) return;
        const orderedIds = displayLayers
          .filter((layer) => selectedLayerIdSet.has(layer.id))
          .map((layer) => layer.id);
        orderedIds.forEach((id, index) => {
          if (index === 0) {
            renameLayer(id, trimmedBase);
            return;
          }
          renameLayer(id, `${trimmedBase}_${String(index).padStart(3, '0')}`);
        });
        return;
      }
      if (activeLayerId) {
        e.preventDefault();
        setEditingLayerId(activeLayerId);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    activeLayerId,
    displayLayers,
    editingLayerId,
    renameLayer,
    selectedLayerIdSet,
    selectedLayerIds.length,
  ]);

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
              isSelected={selectedLayerIdSet.has(layer.id)}
              isEditing={editingLayerId === layer.id}
              isDragging={draggedIds.includes(layer.id)}
              isDropTarget={dropTargetId === layer.id}
              thumbDimensions={{ width: thumbWidth, height: thumbHeight }}
              onActivate={handleLayerActivate}
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
        <div className={`blend-mode-select ${!activeLayer ? 'disabled' : ''}`} ref={blendMenuRef}>
          <button
            type="button"
            className="blend-mode-trigger"
            disabled={!activeLayer}
            onClick={() => setBlendMenuOpen((open) => !open)}
            aria-haspopup="listbox"
            aria-expanded={blendMenuOpen}
            title={activeBlendModeLabel}
          >
            <span className="blend-mode-trigger-label">{activeBlendModeLabel}</span>
            <span className="blend-mode-trigger-chevron" aria-hidden>
              ▾
            </span>
          </button>

          {blendMenuOpen && activeLayer && (
            <div className="blend-mode-dropdown" role="listbox" aria-label="Blend Mode">
              {BLEND_MODE_MENU_ITEMS.map((item) => {
                if (item.kind === 'separator') {
                  return <div key={item.key} className="blend-mode-divider" aria-hidden />;
                }
                const isActive = item.value === activeBlendMode;
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={`blend-mode-option ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      applyBatchLayerBlendMode(item.value);
                      setBlendMenuOpen(false);
                    }}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <label className="opacity-control">
          <span>Opacity:</span>
          <input
            type="range"
            min="0"
            max="100"
            value={activeLayer?.opacity ?? 100}
            onChange={(e) => {
              applyBatchLayerOpacity(Number(e.target.value));
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
          {selectedLayerIds.length > 1 && (
            <button className="context-menu-item" onClick={handleMergeLayerSelection}>
              <FolderPlus size={14} />
              <span>Merge Selected Layers</span>
            </button>
          )}
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
  isSelected: boolean;
  isEditing: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  thumbDimensions: { width: number; height: number };
  onActivate: (id: string, e: React.MouseEvent) => void;
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
  isSelected,
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
      className={`layer-item ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''} ${
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
      onClick={(e) => onActivate(layer.id, e)}
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

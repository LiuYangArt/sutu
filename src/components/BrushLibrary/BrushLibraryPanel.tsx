import { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  Edit2,
  FolderPlus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { BrushPresetThumbnail } from '@/components/BrushPanel/BrushPresetThumbnail';
import {
  useBrushLibraryStore,
  useGroupedBrushPresets,
  useSelectedPresetIdForCurrentTool,
} from '@/stores/brushLibrary';
import './BrushLibraryPanel.css';

interface BrushLibraryPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function BrushLibraryPanel({ isOpen, onClose }: BrushLibraryPanelProps): JSX.Element | null {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const presetCount = useBrushLibraryStore((state) => state.presets.length);
  const tipsCount = useBrushLibraryStore((state) => state.tips.length);
  const selectedPresetId = useSelectedPresetIdForCurrentTool();
  const {
    isLoading,
    error,
    searchQuery,
    setSearchQuery,
    loadLibrary,
    importAbrFile,
    renamePreset,
    deletePreset,
    deleteGroup,
    movePresetToGroup,
    renameGroup,
    applyPresetById,
    clearError,
  } = useBrushLibraryStore();

  const groupedPresets = useGroupedBrushPresets();
  const selectedPreset = useMemo(() => {
    for (const group of groupedPresets) {
      const found = group.presets.find((preset) => preset.id === selectedPresetId);
      if (found) {
        return found;
      }
    }
    return null;
  }, [groupedPresets, selectedPresetId]);

  useEffect(() => {
    if (isOpen && presetCount === 0) {
      void loadLibrary();
    }
  }, [isOpen, presetCount, loadLibrary]);

  const handleImport = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: 'Photoshop Brushes', extensions: ['abr'] }],
      });

      if (!selected) {
        return;
      }

      const paths = Array.isArray(selected) ? selected : [selected];
      for (const path of paths) {
        await importAbrFile(path);
      }
    } catch (err) {
      console.error('[BrushLibrary] import failed', err);
    }
  };

  const handleDelete = async () => {
    if (!selectedPresetId) {
      return;
    }
    try {
      await deletePreset(selectedPresetId);
    } catch (err) {
      console.error('[BrushLibrary] delete failed', err);
    }
  };

  const handleRenamePreset = async () => {
    if (!selectedPreset) {
      return;
    }

    const newName = window.prompt('Preset name', selectedPreset.name)?.trim();
    if (!newName || newName === selectedPreset.name) {
      return;
    }

    try {
      await renamePreset(selectedPreset.id, newName);
    } catch (err) {
      console.error('[BrushLibrary] rename preset failed', err);
    }
  };

  const handleMovePreset = async () => {
    if (!selectedPreset) {
      return;
    }

    const group = window.prompt('Target group', selectedPreset.group ?? '')?.trim();
    if (!group) {
      return;
    }

    try {
      await movePresetToGroup(selectedPreset.id, group);
    } catch (err) {
      console.error('[BrushLibrary] move preset failed', err);
    }
  };

  const handleRenameGroup = async (groupName: string) => {
    const nextName = window.prompt('Rename group', groupName)?.trim();
    if (!nextName || nextName === groupName) {
      return;
    }

    try {
      await renameGroup(groupName, nextName);
      setCollapsedGroups((prev) => {
        if (!prev.has(groupName)) {
          return prev;
        }

        const next = new Set(prev);
        next.delete(groupName);
        next.add(nextName);
        return next;
      });
    } catch (err) {
      console.error('[BrushLibrary] rename group failed', err);
    }
  };

  const handleDeleteGroup = async (groupName: string, presetTotal: number) => {
    const confirmed = window.confirm(
      `Delete group "${groupName}" and all ${presetTotal} presets in it?`
    );
    if (!confirmed) {
      return;
    }

    try {
      await deleteGroup(groupName);
      setCollapsedGroups((prev) => {
        if (!prev.has(groupName)) {
          return prev;
        }

        const next = new Set(prev);
        next.delete(groupName);
        return next;
      });
    } catch (err) {
      console.error('[BrushLibrary] delete group failed', err);
    }
  };

  const toggleGroupCollapsed = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="brush-library-overlay">
      <div className="brush-library-panel mica-panel" onClick={(event) => event.stopPropagation()}>
        <div className="mica-panel-header brush-library-header">
          <h2>Brush Library</h2>
          <button className="brush-library-close-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="brush-library-toolbar">
          <div className="brush-library-search">
            <Search size={14} />
            <input
              type="text"
              placeholder="Search brushes..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>

          <div className="brush-library-actions">
            <button className="brush-library-btn primary" onClick={handleImport}>
              <Upload size={14} />
              Import ABR
            </button>
            <button
              className="brush-library-btn"
              onClick={handleDelete}
              disabled={!selectedPresetId}
              title="Delete selected preset"
            >
              <Trash2 size={14} />
            </button>
            <button
              className="brush-library-btn"
              onClick={handleRenamePreset}
              disabled={!selectedPresetId}
              title="Rename selected preset"
            >
              <Edit2 size={14} />
            </button>
            <button
              className="brush-library-btn"
              onClick={handleMovePreset}
              disabled={!selectedPresetId}
              title="Move selected preset"
            >
              <ArrowRightLeft size={14} />
            </button>
          </div>
        </div>

        {error && (
          <div className="brush-library-error">
            <span>{error}</span>
            <button onClick={clearError}>x</button>
          </div>
        )}

        <div className="brush-library-content">
          {isLoading ? (
            <div className="brush-library-loading">Loading brush library...</div>
          ) : groupedPresets.length === 0 ? (
            <div className="brush-library-empty">
              <FolderPlus size={48} strokeWidth={1} />
              <h3>No Brushes</h3>
              <p>Import an .abr file to get started.</p>
              <button className="brush-library-btn primary" onClick={handleImport}>
                <Upload size={14} />
                Import Brushes
              </button>
            </div>
          ) : (
            groupedPresets.map((group) => {
              const isVirtualGroup = group.presets.every((preset) => preset.group !== group.name);
              const isCollapsed = collapsedGroups.has(group.name);
              return (
                <div key={group.name} className="brush-group">
                  <div className="brush-group-header">
                    <div className="brush-group-header-main">
                      <span className="brush-group-name">{group.name}</span>
                      <span className="brush-group-count">{group.presets.length}</span>
                      <button
                        className="brush-group-icon-btn"
                        onClick={() => {
                          void handleRenameGroup(group.name);
                        }}
                        disabled={isVirtualGroup}
                        title={isVirtualGroup ? 'This group cannot be renamed' : 'Rename group'}
                        aria-label={`Rename group ${group.name}`}
                      >
                        <Edit2 size={12} />
                      </button>
                      <button
                        className="brush-group-icon-btn danger"
                        onClick={() => {
                          void handleDeleteGroup(group.name, group.presets.length);
                        }}
                        disabled={isVirtualGroup}
                        title={
                          isVirtualGroup ? 'This group cannot be deleted' : 'Delete this group'
                        }
                        aria-label={`Delete group ${group.name}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <button
                      className="brush-group-toggle-btn"
                      onClick={() => toggleGroupCollapsed(group.name)}
                      title={isCollapsed ? 'Expand group' : 'Collapse group'}
                      aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} group ${group.name}`}
                    >
                      {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </button>
                  </div>

                  {!isCollapsed && (
                    <div className="brush-grid">
                      {group.presets.map((preset) => (
                        <button
                          key={preset.id}
                          className={`brush-grid-item ${selectedPresetId === preset.id ? 'selected' : ''}`}
                          onClick={() => {
                            applyPresetById(preset.id);
                          }}
                          title={preset.name}
                        >
                          <BrushPresetThumbnail
                            preset={preset}
                            size={48}
                            className="brush-grid-thumb"
                          />
                          <span className="brush-grid-name">{preset.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="brush-library-footer">
          <span>{presetCount} presets</span>
          <span>{tipsCount} tips</span>
        </div>
      </div>
    </div>
  );
}

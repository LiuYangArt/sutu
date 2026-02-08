import { useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Edit2, FolderPlus, Search, Trash2, Upload, X, ArrowRightLeft } from 'lucide-react';
import { BrushPresetThumbnail } from '@/components/BrushPanel/BrushPresetThumbnail';
import {
  useBrushLibraryStore,
  useGroupedBrushPresets,
  type BrushLibraryPreset,
} from '@/stores/brushLibrary';
import './BrushLibraryPanel.css';

interface BrushLibraryPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function BrushLibraryPanel({ isOpen, onClose }: BrushLibraryPanelProps): JSX.Element | null {
  const presetCount = useBrushLibraryStore((state) => state.presets.length);
  const tipsCount = useBrushLibraryStore((state) => state.tips.length);
  const selectedPresetId = useBrushLibraryStore((state) => state.selectedPresetId);
  const {
    isLoading,
    error,
    searchQuery,
    setSearchQuery,
    loadLibrary,
    importAbrFile,
    renamePreset,
    deletePreset,
    movePresetToGroup,
    renameGroup,
    applyPresetById,
    setSelectedPresetId,
    clearError,
  } = useBrushLibraryStore();

  const groupedPresets = useGroupedBrushPresets();

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

  const findSelectedPreset = (): BrushLibraryPreset | null => {
    for (const group of groupedPresets) {
      const found = group.presets.find((preset) => preset.id === selectedPresetId);
      if (found) {
        return found;
      }
    }
    return null;
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
    const selected = findSelectedPreset();
    if (!selected) {
      return;
    }

    const newName = window.prompt('Preset name', selected.name)?.trim();
    if (!newName || newName === selected.name) {
      return;
    }

    try {
      await renamePreset(selected.id, newName);
    } catch (err) {
      console.error('[BrushLibrary] rename preset failed', err);
    }
  };

  const handleMovePreset = async () => {
    const selected = findSelectedPreset();
    if (!selected) {
      return;
    }

    const group = window.prompt('Target group', selected.group ?? '')?.trim();
    if (!group) {
      return;
    }

    try {
      await movePresetToGroup(selected.id, group);
    } catch (err) {
      console.error('[BrushLibrary] move preset failed', err);
    }
  };

  const handleRenameGroup = async () => {
    const selected = findSelectedPreset();
    if (!selected?.group) {
      return;
    }

    const nextName = window.prompt('Rename group', selected.group)?.trim();
    if (!nextName || nextName === selected.group) {
      return;
    }

    try {
      await renameGroup(selected.group, nextName);
    } catch (err) {
      console.error('[BrushLibrary] rename group failed', err);
    }
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
            <button
              className="brush-library-btn"
              onClick={handleRenameGroup}
              disabled={!findSelectedPreset()?.group}
              title="Rename selected group"
            >
              <FolderPlus size={14} />
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
            groupedPresets.map((group) => (
              <div key={group.name} className="brush-group">
                <div className="brush-group-header">
                  <span>{group.name}</span>
                  <span className="brush-group-count">{group.presets.length}</span>
                </div>

                <div className="brush-grid">
                  {group.presets.map((preset) => (
                    <button
                      key={preset.id}
                      className={`brush-grid-item ${selectedPresetId === preset.id ? 'selected' : ''}`}
                      onClick={() => {
                        setSelectedPresetId(preset.id);
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
              </div>
            ))
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

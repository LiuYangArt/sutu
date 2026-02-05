/**
 * Pattern Library Panel
 *
 * A modal panel for managing patterns:
 * - View all patterns in a grid
 * - Import .pat files
 * - Delete/rename patterns
 * - Organize into groups
 */

import { useEffect, useState, useCallback } from 'react';
import { X, Upload, Trash2, Edit2, FolderPlus, Search } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { LZ4Image } from '@/components/common/LZ4Image';
import {
  usePatternLibraryStore,
  useGroupedPatterns,
  getPatternThumbnailUrl,
  PatternResource,
} from '@/stores/pattern';
import './PatternLibraryPanel.css';

interface PatternLibraryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Optional callback when a pattern is selected */
  onSelect?: (patternId: string) => void;
}

export function PatternLibraryPanel({
  isOpen,
  onClose,
  onSelect,
}: PatternLibraryPanelProps): JSX.Element | null {
  const patternCount = usePatternLibraryStore((s) => s.patterns.length);
  const {
    isLoading,
    error,
    searchQuery,
    setSearchQuery,
    loadPatterns,
    importPatFile,
    deletePattern,
    renamePattern,
    clearError,
  } = usePatternLibraryStore();

  const groupedPatterns = useGroupedPatterns();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  // Load patterns on open
  useEffect(() => {
    if (isOpen && patternCount === 0) {
      loadPatterns();
    }
  }, [isOpen, patternCount, loadPatterns]);

  // Handle import
  const handleImport = useCallback(async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: 'Pattern Files', extensions: ['pat'] }],
      });

      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        for (const path of paths) {
          await importPatFile(path);
        }
      }
    } catch (e) {
      console.error('Import failed:', e);
    }
  }, [importPatFile]);

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (selectedId) {
      try {
        await deletePattern(selectedId);
        setSelectedId(null);
      } catch (e) {
        console.error('Delete failed:', e);
      }
    }
  }, [selectedId, deletePattern]);

  // Handle rename
  const handleRenameStart = (pattern: PatternResource) => {
    setEditingId(pattern.id);
    setEditName(pattern.name);
  };

  const handleRenameSubmit = async () => {
    if (editingId && editName.trim()) {
      try {
        await renamePattern(editingId, editName.trim());
        setEditingId(null);
      } catch (e) {
        console.error('Rename failed:', e);
      }
    }
  };

  // Handle selection
  const handlePatternClick = (pattern: PatternResource) => {
    setSelectedId(pattern.id);
    if (onSelect) {
      onSelect(pattern.id);
    }
  };

  // Handle double-click to select and close
  const handlePatternDoubleClick = (pattern: PatternResource) => {
    if (onSelect) {
      onSelect(pattern.id);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="pattern-library-overlay">
      <div className="pattern-library-panel mica-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="mica-panel-header pattern-library-header">
          <h2>Pattern Library</h2>
          <button className="pattern-library-close-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Toolbar */}
        <div className="pattern-library-toolbar">
          <div className="pattern-library-search">
            <Search size={14} />
            <input
              type="text"
              placeholder="Search patterns..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="pattern-library-actions">
            <button
              className="pattern-library-btn primary"
              onClick={handleImport}
              title="Import .pat file"
            >
              <Upload size={14} />
              Import
            </button>
            <button
              className="pattern-library-btn"
              onClick={handleDelete}
              disabled={!selectedId}
              title="Delete selected pattern"
            >
              <Trash2 size={14} />
            </button>
            <button
              className="pattern-library-btn"
              onClick={() => {
                const pattern = groupedPatterns
                  .flatMap((g) => g.patterns)
                  .find((p) => p.id === selectedId);
                if (pattern) handleRenameStart(pattern);
              }}
              disabled={!selectedId}
              title="Rename selected pattern"
            >
              <Edit2 size={14} />
            </button>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="pattern-library-error">
            <span>{error}</span>
            <button onClick={clearError}>×</button>
          </div>
        )}

        {/* Content */}
        <div className="pattern-library-content">
          {isLoading ? (
            <div className="pattern-library-loading">Loading patterns...</div>
          ) : groupedPatterns.length === 0 ? (
            <div className="pattern-library-empty">
              <FolderPlus size={48} strokeWidth={1} />
              <h3>No Patterns</h3>
              <p>Import a .pat file to get started.</p>
              <button className="pattern-library-btn primary" onClick={handleImport}>
                <Upload size={14} />
                Import Patterns
              </button>
            </div>
          ) : (
            groupedPatterns.map((group) => (
              <div key={group.name} className="pattern-group">
                <div className="pattern-group-header">
                  <span>{group.name}</span>
                  <span className="pattern-group-count">{group.patterns.length}</span>
                </div>
                <div className="pattern-grid">
                  {group.patterns.map((pattern) => (
                    <div
                      key={pattern.id}
                      className={`pattern-grid-item ${pattern.id === selectedId ? 'selected' : ''}`}
                      onClick={() => handlePatternClick(pattern)}
                      onDoubleClick={() => handlePatternDoubleClick(pattern)}
                      title={`${pattern.name}\n${pattern.width}×${pattern.height} ${pattern.mode}`}
                    >
                      <div className="pattern-thumbnail">
                        <LZ4Image
                          src={getPatternThumbnailUrl(pattern.id, 80)}
                          alt={pattern.name}
                          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                        />
                      </div>
                      {editingId === pattern.id ? (
                        <input
                          className="pattern-name-input"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={handleRenameSubmit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameSubmit();
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span className="pattern-name">{pattern.name}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

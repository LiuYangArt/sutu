/**
 * Pattern Picker Component
 *
 * A dropdown-style component for selecting patterns from the Pattern Library.
 * Displays pattern thumbnails in a grid and supports search filtering.
 */

import { useState, useEffect, useRef } from 'react';
import { ChevronDown, Plus, Search } from 'lucide-react';
import { LZ4Image } from '@/components/common/LZ4Image';
import {
  usePatternLibraryStore,
  useFilteredPatterns,
  getPatternThumbnailUrl,
  PatternResource,
} from '@/stores/pattern';
import { patternManager } from '@/utils/patternManager';
import './PatternPicker.css';

interface PatternPickerProps {
  /** Currently selected pattern ID */
  selectedId: string | null;
  /** Callback when pattern is selected */
  onSelect: (patternId: string | null) => void;
  /** Whether the picker is disabled */
  disabled?: boolean;
  /** Size of thumbnails (default: 48) */
  thumbnailSize?: number;
}

export function PatternPicker({
  selectedId,
  onSelect,
  disabled = false,
  thumbnailSize = 48,
}: PatternPickerProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { loadPatterns, isLoading, setSearchQuery, searchQuery } = usePatternLibraryStore();
  const patterns = useFilteredPatterns();

  // Load patterns on mount
  useEffect(() => {
    loadPatterns();
  }, [loadPatterns]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Get selected pattern
  const selectedPattern = patterns.find((p) => p.id === selectedId);

  const handlePatternClick = (pattern: PatternResource) => {
    onSelect(pattern.id);
    setIsOpen(false);
    // Pre-load pattern immediately to avoid delay on first stroke
    void patternManager.loadPattern(pattern.id);
  };

  const handleClear = () => {
    onSelect(null);
    setIsOpen(false);
  };

  return (
    <div className={`pattern-picker ${disabled ? 'disabled' : ''}`} ref={dropdownRef}>
      {/* Trigger button */}
      <button
        className="pattern-picker-trigger"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        type="button"
      >
        <div
          className="pattern-picker-preview"
          style={{ width: thumbnailSize, height: thumbnailSize }}
        >
          {selectedPattern ? (
            <LZ4Image
              src={getPatternThumbnailUrl(selectedPattern.id, thumbnailSize)}
              alt={selectedPattern.name}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          ) : (
            <span className="pattern-picker-empty">None</span>
          )}
        </div>
        <span className="pattern-picker-name">{selectedPattern?.name || 'Select Pattern'}</span>
        <ChevronDown size={14} className="pattern-picker-chevron" />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="pattern-picker-dropdown">
          {/* Search bar */}
          <div className="pattern-picker-search">
            <Search size={14} />
            <input
              type="text"
              placeholder="Search patterns..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />
          </div>

          {/* Pattern grid */}
          <div className="pattern-picker-grid">
            {/* Clear option */}
            <button
              className={`pattern-grid-item ${selectedId === null ? 'selected' : ''}`}
              onClick={handleClear}
              title="No Pattern"
            >
              <div className="pattern-grid-thumbnail empty">
                <span>×</span>
              </div>
            </button>

            {renderGridContent()}
          </div>
        </div>
      )}
    </div>
  );

  function renderGridContent(): JSX.Element | JSX.Element[] {
    if (isLoading) {
      return <div className="pattern-picker-loading">Loading...</div>;
    }

    if (patterns.length === 0) {
      return (
        <div className="pattern-picker-empty-state">
          No patterns found.
          <br />
          Import a .pat file to get started.
        </div>
      );
    }

    return patterns.map((pattern) => (
      <button
        key={pattern.id}
        className={`pattern-grid-item ${pattern.id === selectedId ? 'selected' : ''}`}
        onClick={() => handlePatternClick(pattern)}
        title={`${pattern.name} (${pattern.width}×${pattern.height})`}
      >
        <div className="pattern-grid-thumbnail">
          <LZ4Image
            src={getPatternThumbnailUrl(pattern.id, thumbnailSize)}
            alt={pattern.name}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        </div>
      </button>
    ));
  }
}

/**
 * Compact pattern preview button (shows thumbnail + dropdown chevron)
 * For use in tight spaces like the Texture Settings header
 */
interface PatternPreviewButtonProps {
  patternId: string | null;
  onClick: () => void;
  size?: number;
}

export function PatternPreviewButton({
  patternId,
  onClick,
  size = 40,
}: PatternPreviewButtonProps): JSX.Element {
  const patternUrl = patternId ? getPatternThumbnailUrl(patternId, size) : null;

  return (
    <button
      className="pattern-preview-button"
      onClick={onClick}
      title={patternId ? 'Click to change pattern' : 'Select a pattern'}
      style={{ width: size, height: size }}
    >
      {patternUrl ? (
        <LZ4Image
          src={patternUrl}
          alt="Pattern"
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      ) : (
        <Plus size={16} className="pattern-preview-add-icon" />
      )}
    </button>
  );
}

/**
 * Pattern Library Store
 *
 * Manages pattern resources for the Pattern Library feature:
 * - Fetches patterns from backend via IPC
 * - Tracks selected pattern for texture application
 * - Supports .pat file import and pattern management
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// Types
// ============================================================================

/** Pattern mode (color space) */
export type PatternMode = 'Grayscale' | 'RGB' | 'Indexed';

/** Pattern resource from library */
export interface PatternResource {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Content hash for deduplication */
  contentHash: string;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** Color mode */
  mode: PatternMode;
  /** Source file path or "user-added" */
  source: string;
  /** Group name (optional) */
  group: string | null;
}

/** Import result from .pat file */
export interface PatternImportResult {
  /** Number of patterns imported */
  importedCount: number;
  /** Number skipped (duplicates) */
  skippedCount: number;
  /** IDs of imported patterns */
  patternIds: string[];
}

/** Pattern group with patterns */
export interface PatternGroup {
  name: string;
  patterns: PatternResource[];
}

// ============================================================================
// Store State & Actions
// ============================================================================

interface PatternLibraryState {
  /** All patterns in the library */
  patterns: PatternResource[];
  /** Loading state */
  isLoading: boolean;
  /** Error message (if any) */
  error: string | null;
  /** Search query for filtering */
  searchQuery: string;

  // Actions
  /** Load all patterns from backend */
  loadPatterns: () => Promise<void>;
  /** Import a .pat file */
  importPatFile: (path: string) => Promise<PatternImportResult>;
  /** Delete a pattern */
  deletePattern: (id: string) => Promise<void>;
  /** Rename a pattern */
  renamePattern: (id: string, newName: string) => Promise<void>;
  /** Move pattern to a group */
  moveToGroup: (id: string, group: string) => Promise<void>;
  /** Rename a group */
  renameGroup: (oldName: string, newName: string) => Promise<void>;
  /** Set search query */
  setSearchQuery: (query: string) => void;
  /** Clear error */
  clearError: () => void;
}

export const usePatternLibraryStore = create<PatternLibraryState>((set, get) => ({
  patterns: [],
  isLoading: false,
  error: null,
  searchQuery: '',

  loadPatterns: async () => {
    set({ isLoading: true, error: null });
    try {
      const patterns = await invoke<PatternResource[]>('get_patterns');
      set({ patterns, isLoading: false });
    } catch (e) {
      set({ error: String(e), isLoading: false });
    }
  },

  importPatFile: async (path: string) => {
    set({ isLoading: true, error: null });
    try {
      const result = await invoke<PatternImportResult>('import_pat_file', { path });
      // Reload patterns to get fresh list
      await get().loadPatterns();
      return result;
    } catch (e) {
      set({ error: String(e), isLoading: false });
      throw e;
    }
  },

  deletePattern: async (id: string) => {
    try {
      await invoke('delete_pattern', { id });
      // Remove from local state
      set((state) => ({
        patterns: state.patterns.filter((p) => p.id !== id),
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  renamePattern: async (id: string, newName: string) => {
    try {
      await invoke('rename_pattern', { id, newName });
      // Update local state
      set((state) => ({
        patterns: state.patterns.map((p) => (p.id === id ? { ...p, name: newName } : p)),
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  moveToGroup: async (id: string, group: string) => {
    try {
      await invoke('move_pattern_to_group', { id, group });
      // Update local state
      set((state) => ({
        patterns: state.patterns.map((p) => (p.id === id ? { ...p, group } : p)),
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  renameGroup: async (oldName: string, newName: string) => {
    try {
      await invoke('rename_pattern_group', { oldName, newName });
      // Update local state
      set((state) => ({
        patterns: state.patterns.map((p) => (p.group === oldName ? { ...p, group: newName } : p)),
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  setSearchQuery: (query: string) => set({ searchQuery: query }),

  clearError: () => set({ error: null }),
}));

// ============================================================================
// Selectors
// ============================================================================

/** Get patterns filtered by search query */
export const useFilteredPatterns = () => {
  const patterns = usePatternLibraryStore((s) => s.patterns);
  const query = usePatternLibraryStore((s) => s.searchQuery);

  if (!query.trim()) return patterns;

  const lowerQuery = query.toLowerCase();
  return patterns.filter(
    (p) => p.name.toLowerCase().includes(lowerQuery) || p.group?.toLowerCase().includes(lowerQuery)
  );
};

/** Get patterns grouped by group name */
export const useGroupedPatterns = (): PatternGroup[] => {
  const patterns = useFilteredPatterns();

  const groups = new Map<string, PatternResource[]>();

  for (const pattern of patterns) {
    const groupName = pattern.group || 'Ungrouped';
    if (!groups.has(groupName)) {
      groups.set(groupName, []);
    }
    groups.get(groupName)!.push(pattern);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, patterns]) => ({ name, patterns }));
};

/** Get pattern thumbnail URL */
const THUMB_BUCKETS = [32, 48, 80] as const;

export function normalizePatternThumbSize(size: number): number {
  if (!Number.isFinite(size)) return 48;
  const clamped = Math.min(256, Math.max(16, Math.round(size)));
  let best = THUMB_BUCKETS[0];
  let bestDiff = Math.abs(best - clamped);
  for (const s of THUMB_BUCKETS.slice(1)) {
    const diff = Math.abs(s - clamped);
    if (diff < bestDiff || (diff === bestDiff && s > best)) {
      best = s;
      bestDiff = diff;
    }
  }
  return best;
}

/** Get pattern thumbnail URL (optional thumb size bucket) */
export const getPatternThumbnailUrl = (id: string, thumbSize?: number): string => {
  if (thumbSize === undefined) {
    return `http://project.localhost/pattern/${id}`;
  }
  const normalized = normalizePatternThumbSize(thumbSize);
  return `http://project.localhost/pattern/${id}?thumb=${normalized}`;
};

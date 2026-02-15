import type { HistoryEntry } from '@/stores/history';

export interface HistoryTimeline {
  entries: HistoryEntry[];
  currentIndex: number;
}

export function buildHistoryTimeline(
  undoStack: HistoryEntry[],
  redoStack: HistoryEntry[]
): HistoryTimeline {
  return {
    entries: [...undoStack, ...[...redoStack].reverse()],
    currentIndex: undoStack.length - 1,
  };
}

export function formatHistoryEntryLabel(entry: HistoryEntry): string {
  switch (entry.type) {
    case 'stroke':
      return entry.snapshotMode === 'gpu' ? 'Brush Stroke (GPU)' : 'Brush Stroke';
    case 'addLayer':
      return 'Add Layer';
    case 'removeLayer':
      return 'Delete Layer';
    case 'removeLayers':
      return entry.layers.length > 1 ? `Delete ${entry.layers.length} Layers` : 'Delete Layer';
    case 'mergeLayers':
      return 'Merge Layers';
    case 'layerProps':
      return 'Layer Properties';
    case 'resizeCanvas':
      return 'Resize Canvas';
    case 'selection':
      return 'Selection Change';
  }
}

export function getHistoryEntryKey(entry: HistoryEntry, index: number): string {
  switch (entry.type) {
    case 'stroke':
      return `stroke-${entry.entryId}`;
    case 'addLayer':
      return `addLayer-${entry.layerId}-${entry.timestamp}-${index}`;
    case 'removeLayer':
      return `removeLayer-${entry.layerId}-${entry.timestamp}-${index}`;
    case 'removeLayers':
      return `removeLayers-${entry.timestamp}-${index}`;
    case 'mergeLayers':
      return `mergeLayers-${entry.targetLayerId}-${entry.timestamp}-${index}`;
    case 'layerProps':
      return `layerProps-${entry.timestamp}-${index}`;
    case 'resizeCanvas':
      return `resizeCanvas-${entry.timestamp}-${index}`;
    case 'selection':
      return `selection-${entry.timestamp}-${index}`;
  }
}

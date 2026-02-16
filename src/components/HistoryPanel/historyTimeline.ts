import type { HistoryEntry } from '@/stores/history';
import { t } from '@/i18n';

export interface HistoryTimeline {
  entries: HistoryEntry[];
  currentIndex: number;
}

const STROKE_LABEL_BY_PREFIX: Array<{ prefix: string; key: string }> = [
  { prefix: 'fill-selection-', key: 'historyPanel.entry.fillSelection' },
  { prefix: 'fill-layer-', key: 'historyPanel.entry.fillLayer' },
  { prefix: 'selection-fill-', key: 'historyPanel.entry.selectionFill' },
  { prefix: 'clear-selection-', key: 'historyPanel.entry.clearSelection' },
  { prefix: 'clear-layer-', key: 'historyPanel.entry.clearLayer' },
  { prefix: 'gradient-', key: 'historyPanel.entry.gradientFill' },
  { prefix: 'curves-', key: 'historyPanel.entry.curvesAdjustment' },
];

function resolveStrokeLabel(entryId: string): string | null {
  for (const candidate of STROKE_LABEL_BY_PREFIX) {
    if (entryId.startsWith(candidate.prefix)) return t(candidate.key);
  }
  return null;
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
    case 'stroke': {
      const actionLabel = resolveStrokeLabel(entry.entryId);
      if (actionLabel) return actionLabel;
      return entry.snapshotMode === 'gpu'
        ? t('historyPanel.entry.brushStrokeGpu')
        : t('historyPanel.entry.brushStroke');
    }
    case 'addLayer':
      return t('historyPanel.entry.addLayer');
    case 'removeLayer':
      return t('historyPanel.entry.deleteLayer');
    case 'removeLayers':
      return entry.layers.length > 1
        ? t('historyPanel.entry.deleteLayers', { count: entry.layers.length })
        : t('historyPanel.entry.deleteLayer');
    case 'mergeLayers':
      return t('historyPanel.entry.mergeLayers');
    case 'layerProps':
      return t('historyPanel.entry.layerProperties');
    case 'resizeCanvas':
      return t('historyPanel.entry.resizeCanvas');
    case 'selection':
      return t('historyPanel.entry.selectionChange');
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

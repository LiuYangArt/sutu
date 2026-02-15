import { describe, expect, it } from 'vitest';
import { formatHistoryEntryLabel } from './historyTimeline';
import type { StrokeEntry } from '@/stores/history';

function createStrokeEntry(entryId: string): StrokeEntry {
  return {
    type: 'stroke',
    layerId: 'layer-1',
    entryId,
    snapshotMode: 'cpu',
    beforeImage: new ImageData(1, 1),
    timestamp: Date.now(),
  };
}

describe('historyTimeline.formatHistoryEntryLabel', () => {
  it('maps stroke entry prefixes to specific labels', () => {
    expect(formatHistoryEntryLabel(createStrokeEntry('fill-selection-1'))).toBe('Fill Selection');
    expect(formatHistoryEntryLabel(createStrokeEntry('fill-layer-1'))).toBe('Fill Layer');
    expect(formatHistoryEntryLabel(createStrokeEntry('selection-fill-1'))).toBe('Selection Fill');
    expect(formatHistoryEntryLabel(createStrokeEntry('clear-selection-1'))).toBe('Clear Selection');
    expect(formatHistoryEntryLabel(createStrokeEntry('clear-layer-1'))).toBe('Clear Layer');
    expect(formatHistoryEntryLabel(createStrokeEntry('gradient-1'))).toBe('Gradient Fill');
    expect(formatHistoryEntryLabel(createStrokeEntry('curves-1'))).toBe('Curves Adjustment');
  });

  it('falls back to brush stroke label', () => {
    expect(formatHistoryEntryLabel(createStrokeEntry('stroke-1'))).toBe('Brush Stroke');
  });
});

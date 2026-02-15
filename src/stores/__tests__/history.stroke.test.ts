import { beforeEach, describe, expect, it } from 'vitest';
import { useHistoryStore } from '../history';
import type { SelectionSnapshot } from '../selection';

describe('HistoryStore - stroke entry', () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
  });

  it('stores CPU stroke snapshots with cloned beforeImage', () => {
    const store = useHistoryStore.getState();
    const image = new ImageData(new Uint8ClampedArray([1, 2, 3, 4]), 1, 1);

    store.pushStroke({
      layerId: 'layer_a',
      entryId: 'cpu-entry-1',
      snapshotMode: 'cpu',
      beforeImage: image,
    });

    image.data[0] = 99;

    const entry = useHistoryStore.getState().undoStack[0];
    expect(entry?.type).toBe('stroke');
    if (!entry || entry.type !== 'stroke') return;
    expect(entry.entryId).toBe('cpu-entry-1');
    expect(entry.snapshotMode).toBe('cpu');
    expect(entry.beforeImage?.data[0]).toBe(1);
  });

  it('stores GPU stroke snapshots without beforeImage payload', () => {
    const store = useHistoryStore.getState();

    store.pushStroke({
      layerId: 'layer_a',
      entryId: 'gpu-entry-1',
      snapshotMode: 'gpu',
    });

    const entry = useHistoryStore.getState().undoStack[0];
    expect(entry?.type).toBe('stroke');
    if (!entry || entry.type !== 'stroke') return;
    expect(entry.entryId).toBe('gpu-entry-1');
    expect(entry.snapshotMode).toBe('gpu');
    expect(entry.beforeImage).toBeUndefined();
  });

  it('stores move stroke selection snapshots for undo/redo sync', () => {
    const store = useHistoryStore.getState();
    const image = new ImageData(new Uint8ClampedArray([1, 2, 3, 4]), 1, 1);
    const selectionBefore: SelectionSnapshot = {
      hasSelection: true,
      selectionMask: new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1),
      selectionMaskPending: false,
      selectionPath: [[{ x: 1, y: 1, type: 'polygonal' }]],
      bounds: { x: 1, y: 1, width: 5, height: 5 },
    };
    const selectionAfter: SelectionSnapshot = {
      hasSelection: true,
      selectionMask: new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1),
      selectionMaskPending: false,
      selectionPath: [[{ x: 3, y: 2, type: 'polygonal' }]],
      bounds: { x: 3, y: 2, width: 5, height: 5 },
    };

    store.pushStroke({
      layerId: 'layer_a',
      entryId: 'move-entry-1',
      snapshotMode: 'cpu',
      beforeImage: image,
      selectionBefore,
      selectionAfter,
    });

    const entry = useHistoryStore.getState().undoStack[0];
    expect(entry?.type).toBe('stroke');
    if (!entry || entry.type !== 'stroke') return;
    expect(entry.selectionBefore).toBe(selectionBefore);
    expect(entry.selectionAfter).toBe(selectionAfter);
  });

  it('preserves selection snapshots through undo/redo stack transitions', () => {
    const store = useHistoryStore.getState();
    const image = new ImageData(new Uint8ClampedArray([1, 2, 3, 4]), 1, 1);
    const selectionBefore: SelectionSnapshot = {
      hasSelection: true,
      selectionMask: new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1),
      selectionMaskPending: false,
      selectionPath: [[{ x: 0, y: 0, type: 'polygonal' }]],
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    };
    const selectionAfter: SelectionSnapshot = {
      hasSelection: true,
      selectionMask: new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1),
      selectionMaskPending: false,
      selectionPath: [[{ x: 2, y: 2, type: 'polygonal' }]],
      bounds: { x: 2, y: 2, width: 1, height: 1 },
    };

    store.pushStroke({
      layerId: 'layer_auto_fill',
      entryId: 'selection-fill-entry',
      snapshotMode: 'cpu',
      beforeImage: image,
      selectionBefore,
      selectionAfter,
    });

    const undone = store.undo();
    expect(undone?.type).toBe('stroke');
    if (!undone || undone.type !== 'stroke') return;
    expect(undone.selectionBefore).toBe(selectionBefore);
    expect(undone.selectionAfter).toBe(selectionAfter);

    const redone = store.redo();
    expect(redone?.type).toBe('stroke');
    if (!redone || redone.type !== 'stroke') return;
    expect(redone.selectionBefore).toBe(selectionBefore);
    expect(redone.selectionAfter).toBe(selectionAfter);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { useHistoryStore } from '../history';
import type { SelectionSnapshot } from '../selection';

describe('HistoryStore - selection', () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
  });

  it('pushSelection should push entry and clear redo stack', () => {
    const store = useHistoryStore.getState();

    // Create redo stack first
    const img = new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1);
    store.pushStroke({
      layerId: 'layer_a',
      entryId: 'stroke-test-1',
      snapshotMode: 'cpu',
      beforeImage: img,
    });
    store.undo();
    expect(store.canRedo()).toBe(true);

    const before: SelectionSnapshot = {
      hasSelection: true,
      selectionMask: new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1),
      selectionMaskPending: false,
      selectionPath: [[{ x: 0, y: 0, type: 'polygonal' }]],
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    };

    store.pushSelection(before);

    const state = useHistoryStore.getState();
    const last = state.undoStack[state.undoStack.length - 1];
    expect(last && last.type).toBe('selection');
    if (last && last.type === 'selection') {
      expect(last.before).toBe(before);
    }
    expect(state.redoStack).toHaveLength(0);
  });
});

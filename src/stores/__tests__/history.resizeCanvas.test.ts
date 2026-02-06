import { describe, it, expect, beforeEach } from 'vitest';
import { useHistoryStore } from '../history';

describe('HistoryStore - resizeCanvas', () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
  });

  it('pushResizeCanvas should push entry and clear redo stack', () => {
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

    store.pushResizeCanvas(100, 80, [{ layerId: 'layer_a', imageData: img }]);

    const state = useHistoryStore.getState();
    const last = state.undoStack[state.undoStack.length - 1];
    expect(last && last.type).toBe('resizeCanvas');
    if (last && last.type === 'resizeCanvas') {
      expect(last.beforeWidth).toBe(100);
      expect(last.beforeHeight).toBe(80);
      expect(last.beforeLayers).toHaveLength(1);
      expect(last.beforeLayers[0]?.layerId).toBe('layer_a');
    }
    expect(state.redoStack).toHaveLength(0);
  });

  it('should deep-clone ImageData snapshots', () => {
    const store = useHistoryStore.getState();
    const img = new ImageData(new Uint8ClampedArray([1, 2, 3, 4]), 1, 1);

    store.pushResizeCanvas(10, 10, [{ layerId: 'layer_a', imageData: img }]);

    // Mutate original after pushing
    img.data[0] = 9;

    const state = useHistoryStore.getState();
    const entry = state.undoStack[0];
    expect(entry && entry.type).toBe('resizeCanvas');
    if (entry && entry.type === 'resizeCanvas') {
      expect(entry.beforeLayers[0]?.imageData.data[0]).toBe(1);
    }
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { useHistoryStore } from '../history';

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
});

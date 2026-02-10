import { beforeEach, describe, expect, it } from 'vitest';
import { useHistoryStore } from '../history';
import type { Layer } from '../document';

function createLayer(id: string, name: string): Layer {
  return {
    id,
    name,
    type: 'raster',
    visible: true,
    locked: false,
    opacity: 100,
    blendMode: 'normal',
    isBackground: false,
  };
}

describe('HistoryStore - addLayer image patch', () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
  });

  it('patchAddLayerImage stores cloned image data in addLayer entry', () => {
    const store = useHistoryStore.getState();
    store.pushAddLayer('layer_a', createLayer('layer_a', 'Layer A'), 0);

    const imageData = new ImageData(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1);
    store.patchAddLayerImage('layer_a', imageData);
    imageData.data[0] = 99;

    const entry = useHistoryStore.getState().undoStack[0];
    expect(entry?.type).toBe('addLayer');
    if (!entry || entry.type !== 'addLayer') return;
    expect(entry.imageData).toBeDefined();
    expect(entry.imageData?.data[0]).toBe(1);
  });

  it('patchAddLayerImage can patch addLayer entry in redo stack', () => {
    const store = useHistoryStore.getState();
    store.pushAddLayer('layer_a', createLayer('layer_a', 'Layer A'), 0);
    store.pushAddLayer('layer_b', createLayer('layer_b', 'Layer B'), 1);
    store.undo();

    const imageData = new ImageData(new Uint8ClampedArray([9, 8, 7, 255]), 1, 1);
    store.patchAddLayerImage('layer_b', imageData);

    const redoEntry = useHistoryStore.getState().redoStack[0];
    expect(redoEntry?.type).toBe('addLayer');
    if (!redoEntry || redoEntry.type !== 'addLayer') return;
    expect(redoEntry.layerId).toBe('layer_b');
    expect(redoEntry.imageData?.data[0]).toBe(9);
  });
});

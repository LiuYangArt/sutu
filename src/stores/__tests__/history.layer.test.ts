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

  it('pushRemoveLayers stores cloned layer snapshots', () => {
    const store = useHistoryStore.getState();
    const imageData = new ImageData(new Uint8ClampedArray([5, 6, 7, 255]), 1, 1);
    const removed = [
      {
        layerId: 'layer_a',
        layerMeta: createLayer('layer_a', 'Layer A'),
        layerIndex: 0,
        imageData,
      },
    ];

    store.pushRemoveLayers(
      removed,
      {
        activeLayerId: 'layer_a',
        selectedLayerIds: ['layer_a'],
        layerSelectionAnchorId: 'layer_a',
      },
      {
        activeLayerId: 'layer_b',
        selectedLayerIds: ['layer_b'],
        layerSelectionAnchorId: 'layer_b',
      }
    );

    imageData.data[0] = 99;
    removed[0]!.layerMeta.name = 'Mutated';

    const entry = useHistoryStore.getState().undoStack[0];
    expect(entry?.type).toBe('removeLayers');
    if (!entry || entry.type !== 'removeLayers') return;
    expect(entry.layers[0]?.imageData.data[0]).toBe(5);
    expect(entry.layers[0]?.layerMeta.name).toBe('Layer A');
    expect(entry.beforeSelection.selectedLayerIds).toEqual(['layer_a']);
  });

  it('pushMergeLayers stores cloned payload', () => {
    const store = useHistoryStore.getState();
    const beforeImage = new ImageData(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1);
    const afterImage = new ImageData(new Uint8ClampedArray([9, 8, 7, 255]), 1, 1);

    store.pushMergeLayers({
      targetLayerId: 'layer_top',
      targetBeforeMeta: createLayer('layer_top', 'Top'),
      targetAfterMeta: { ...createLayer('layer_top', 'Top'), blendMode: 'normal', opacity: 100 },
      targetBeforeImage: beforeImage,
      targetAfterImage: afterImage,
      removedLayers: [
        {
          layerId: 'layer_bottom',
          layerMeta: createLayer('layer_bottom', 'Bottom'),
          layerIndex: 0,
          imageData: new ImageData(new Uint8ClampedArray([4, 4, 4, 255]), 1, 1),
        },
      ],
      beforeOrder: ['layer_bottom', 'layer_top'],
      afterOrder: ['layer_top'],
      beforeSelection: {
        activeLayerId: 'layer_top',
        selectedLayerIds: ['layer_bottom', 'layer_top'],
        layerSelectionAnchorId: 'layer_bottom',
      },
      afterSelection: {
        activeLayerId: 'layer_top',
        selectedLayerIds: ['layer_top'],
        layerSelectionAnchorId: 'layer_top',
      },
    });

    beforeImage.data[0] = 77;

    const entry = useHistoryStore.getState().undoStack[0];
    expect(entry?.type).toBe('mergeLayers');
    if (!entry || entry.type !== 'mergeLayers') return;
    expect(entry.targetBeforeImage.data[0]).toBe(1);
    expect(entry.afterOrder).toEqual(['layer_top']);
    expect(entry.removedLayers[0]?.layerId).toBe('layer_bottom');
  });

  it('pushLayerProps stores cloned before/after layer properties', () => {
    const store = useHistoryStore.getState();
    const changes = [
      {
        layerId: 'layer_a',
        beforeOpacity: 100,
        beforeBlendMode: 'normal' as Layer['blendMode'],
        afterOpacity: 42,
        afterBlendMode: 'multiply' as Layer['blendMode'],
      },
    ];

    store.pushLayerProps(changes);
    changes[0]!.afterOpacity = 99;
    changes[0]!.afterBlendMode = 'screen';

    const entry = useHistoryStore.getState().undoStack[0];
    expect(entry?.type).toBe('layerProps');
    if (!entry || entry.type !== 'layerProps') return;
    expect(entry.changes[0]).toEqual({
      layerId: 'layer_a',
      beforeOpacity: 100,
      beforeBlendMode: 'normal',
      afterOpacity: 42,
      afterBlendMode: 'multiply',
    });
  });

  it('pushLayerProps merges continuous opacity changes into one entry', () => {
    const store = useHistoryStore.getState();
    store.pushLayerProps([
      {
        layerId: 'layer_a',
        beforeOpacity: 100,
        beforeBlendMode: 'normal',
        afterOpacity: 90,
        afterBlendMode: 'normal',
      },
    ]);
    store.pushLayerProps([
      {
        layerId: 'layer_a',
        beforeOpacity: 90,
        beforeBlendMode: 'normal',
        afterOpacity: 80,
        afterBlendMode: 'normal',
      },
    ]);
    store.pushLayerProps([
      {
        layerId: 'layer_a',
        beforeOpacity: 80,
        beforeBlendMode: 'normal',
        afterOpacity: 60,
        afterBlendMode: 'normal',
      },
    ]);

    const undoStack = useHistoryStore.getState().undoStack;
    expect(undoStack).toHaveLength(1);
    const entry = undoStack[0];
    expect(entry?.type).toBe('layerProps');
    if (!entry || entry.type !== 'layerProps') return;
    expect(entry.changes).toEqual([
      {
        layerId: 'layer_a',
        beforeOpacity: 100,
        beforeBlendMode: 'normal',
        afterOpacity: 60,
        afterBlendMode: 'normal',
      },
    ]);
  });

  it('pushLayerProps keeps blend-mode change as a separate history entry', () => {
    const store = useHistoryStore.getState();
    store.pushLayerProps([
      {
        layerId: 'layer_a',
        beforeOpacity: 100,
        beforeBlendMode: 'normal',
        afterOpacity: 70,
        afterBlendMode: 'normal',
      },
    ]);
    store.pushLayerProps([
      {
        layerId: 'layer_a',
        beforeOpacity: 70,
        beforeBlendMode: 'normal',
        afterOpacity: 70,
        afterBlendMode: 'multiply',
      },
    ]);

    const undoStack = useHistoryStore.getState().undoStack;
    expect(undoStack).toHaveLength(2);
    expect(undoStack[0]?.type).toBe('layerProps');
    expect(undoStack[1]?.type).toBe('layerProps');
  });
});

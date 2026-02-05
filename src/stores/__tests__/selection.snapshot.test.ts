import { describe, it, expect, beforeEach } from 'vitest';
import { useSelectionStore } from '../selection';

describe('SelectionStore - snapshot', () => {
  beforeEach(() => {
    useSelectionStore.setState({
      hasSelection: false,
      selectionMask: null,
      selectionPath: [],
      bounds: null,

      isCreating: false,
      creationPoints: [],
      previewPoint: null,
      creationStart: null,

      isMoving: false,
      moveStartPoint: null,
      originalPath: [],
      originalBounds: null,

      selectionMode: 'new',
      lassoMode: 'freehand',
      featherRadius: 0,
      marchingAntsOffset: 0,
    });
  });

  it('createSnapshot and applySnapshot should restore core state and reset interaction state', () => {
    const mask = new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1);
    const selectionPath = [[{ x: 1, y: 2, type: 'polygonal' as const }]];
    const bounds = { x: 1, y: 2, width: 3, height: 4 };

    useSelectionStore.setState({
      hasSelection: true,
      selectionMask: mask,
      selectionPath,
      bounds,

      isCreating: true,
      creationPoints: [{ x: 10, y: 10, type: 'freehand' }],
      previewPoint: { x: 11, y: 11, type: 'freehand' },
      creationStart: { x: 9, y: 9, type: 'freehand' },

      isMoving: true,
      moveStartPoint: { x: 5, y: 6, type: 'freehand' },
      originalPath: [[{ x: 0, y: 0, type: 'polygonal' }]],
      originalBounds: { x: 0, y: 0, width: 1, height: 1 },

      selectionMode: 'add',
      lassoMode: 'polygonal',
      featherRadius: 7,
      marchingAntsOffset: 3,
    });

    const snapshot = useSelectionStore.getState().createSnapshot();
    expect(snapshot.hasSelection).toBe(true);
    expect(snapshot.selectionMask).toBe(mask);
    expect(snapshot.selectionPath).toBe(selectionPath);
    expect(snapshot.bounds).toBe(bounds);

    useSelectionStore.getState().applySnapshot(null);
    const cleared = useSelectionStore.getState();
    expect(cleared.hasSelection).toBe(false);
    expect(cleared.selectionMask).toBeNull();
    expect(cleared.selectionPath).toEqual([]);
    expect(cleared.bounds).toBeNull();

    expect(cleared.isCreating).toBe(false);
    expect(cleared.creationPoints).toEqual([]);
    expect(cleared.previewPoint).toBeNull();
    expect(cleared.creationStart).toBeNull();

    expect(cleared.isMoving).toBe(false);
    expect(cleared.moveStartPoint).toBeNull();
    expect(cleared.originalPath).toEqual([]);
    expect(cleared.originalBounds).toBeNull();

    // Preserve user preferences / rendering state
    expect(cleared.selectionMode).toBe('add');
    expect(cleared.lassoMode).toBe('polygonal');
    expect(cleared.featherRadius).toBe(7);
    expect(cleared.marchingAntsOffset).toBe(3);

    useSelectionStore.getState().applySnapshot(snapshot);
    const restored = useSelectionStore.getState();
    expect(restored.hasSelection).toBe(true);
    expect(restored.selectionMask).toBe(mask);
    expect(restored.selectionPath).toBe(selectionPath);
    expect(restored.bounds).toBe(bounds);

    // Interaction state should be reset after applying snapshot
    expect(restored.isCreating).toBe(false);
    expect(restored.isMoving).toBe(false);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { useDocumentStore } from '../document';

describe('DocumentStore', () => {
  beforeEach(() => {
    // Reset store before each test
    useDocumentStore.getState().reset();
  });

  describe('initDocument', () => {
    it('should initialize document with given dimensions', () => {
      const store = useDocumentStore.getState();

      store.initDocument({ width: 1920, height: 1080, dpi: 300 });

      const state = useDocumentStore.getState();
      expect(state.width).toBe(1920);
      expect(state.height).toBe(1080);
      expect(state.dpi).toBe(300);
    });

    it('should create a default background layer', () => {
      const store = useDocumentStore.getState();

      store.initDocument({ width: 800, height: 600, dpi: 72 });

      const state = useDocumentStore.getState();
      expect(state.layers).toHaveLength(1);

      const firstLayer = state.layers[0];
      expect(firstLayer).toBeDefined();
      expect(firstLayer!.name).toBe('Background');
      expect(firstLayer!.type).toBe('raster');
      expect(state.activeLayerId).toBe(firstLayer!.id);
    });

    it('should support transparent background (no Background layer)', () => {
      const store = useDocumentStore.getState();

      store.initDocument({
        width: 800,
        height: 600,
        dpi: 72,
        background: { preset: 'transparent' },
      });

      const state = useDocumentStore.getState();
      expect(state.layers).toHaveLength(1);
      expect(state.layers[0]!.name).toBe('Layer 1');
      expect(state.layers[0]!.isBackground).not.toBe(true);
    });

    it('should set backgroundFillColor when creating a background layer', () => {
      const store = useDocumentStore.getState();

      store.initDocument({
        width: 800,
        height: 600,
        dpi: 72,
        background: { preset: 'black', fillColor: '#000000' },
      });

      const state = useDocumentStore.getState();
      expect(state.backgroundFillColor).toBe('#000000');
      expect(state.layers).toHaveLength(1);
      expect(state.layers[0]!.name).toBe('Background');
      expect(state.layers[0]!.isBackground).toBe(true);
    });
  });

  describe('addLayer', () => {
    beforeEach(() => {
      useDocumentStore.getState().initDocument({ width: 800, height: 600, dpi: 72 });
    });

    it('should add a new layer', () => {
      const store = useDocumentStore.getState();

      store.addLayer({ name: 'Layer 1', type: 'raster' });

      const state = useDocumentStore.getState();
      expect(state.layers).toHaveLength(2);

      const secondLayer = state.layers[1];
      expect(secondLayer).toBeDefined();
      expect(secondLayer!.name).toBe('Layer 1');
    });

    it('should set new layer as active', () => {
      const store = useDocumentStore.getState();

      store.addLayer({ name: 'Layer 1', type: 'raster' });

      const state = useDocumentStore.getState();
      const secondLayer = state.layers[1];
      expect(secondLayer).toBeDefined();
      expect(state.activeLayerId).toBe(secondLayer!.id);
    });

    it('should create layer with default properties', () => {
      const store = useDocumentStore.getState();

      store.addLayer({ name: 'Test', type: 'raster' });

      const layer = useDocumentStore.getState().layers[1];
      expect(layer).toBeDefined();
      expect(layer!.visible).toBe(true);
      expect(layer!.locked).toBe(false);
      expect(layer!.opacity).toBe(100);
      expect(layer!.blendMode).toBe('normal');
    });
  });

  describe('removeLayer', () => {
    beforeEach(() => {
      const store = useDocumentStore.getState();
      store.initDocument({ width: 800, height: 600, dpi: 72 });
      store.addLayer({ name: 'Layer 1', type: 'raster' });
      store.addLayer({ name: 'Layer 2', type: 'raster' });
    });

    it('should remove the specified layer', () => {
      const state = useDocumentStore.getState();
      const layerToRemove = state.layers[1];
      expect(layerToRemove).toBeDefined();

      state.removeLayer(layerToRemove!.id);

      expect(useDocumentStore.getState().layers).toHaveLength(2);
      expect(
        useDocumentStore.getState().layers.find((l) => l.id === layerToRemove!.id)
      ).toBeUndefined();
    });

    it('should update active layer when removing active layer', () => {
      const state = useDocumentStore.getState();
      const activeId = state.activeLayerId!;

      state.removeLayer(activeId);

      const newState = useDocumentStore.getState();
      expect(newState.activeLayerId).not.toBe(activeId);
      expect(newState.activeLayerId).not.toBeNull();
    });

    it('should not remove non-existent layer', () => {
      const state = useDocumentStore.getState();
      const initialCount = state.layers.length;

      state.removeLayer('non-existent-id');

      expect(useDocumentStore.getState().layers).toHaveLength(initialCount);
    });
  });

  describe('toggleLayerVisibility', () => {
    beforeEach(() => {
      useDocumentStore.getState().initDocument({ width: 800, height: 600, dpi: 72 });
    });

    it('should toggle layer visibility', () => {
      const state = useDocumentStore.getState();
      const firstLayer = state.layers[0];
      expect(firstLayer).toBeDefined();
      const layerId = firstLayer!.id;

      expect(firstLayer!.visible).toBe(true);

      state.toggleLayerVisibility(layerId);
      expect(useDocumentStore.getState().layers[0]!.visible).toBe(false);

      useDocumentStore.getState().toggleLayerVisibility(layerId);
      expect(useDocumentStore.getState().layers[0]!.visible).toBe(true);
    });
  });

  describe('setLayerOpacity', () => {
    beforeEach(() => {
      useDocumentStore.getState().initDocument({ width: 800, height: 600, dpi: 72 });
    });

    it('should set layer opacity', () => {
      const state = useDocumentStore.getState();
      const firstLayer = state.layers[0];
      expect(firstLayer).toBeDefined();
      const layerId = firstLayer!.id;

      state.setLayerOpacity(layerId, 50);

      expect(useDocumentStore.getState().layers[0]!.opacity).toBe(50);
    });

    it('should clamp opacity to valid range', () => {
      const state = useDocumentStore.getState();
      const firstLayer = state.layers[0];
      expect(firstLayer).toBeDefined();
      const layerId = firstLayer!.id;

      state.setLayerOpacity(layerId, 150);
      expect(useDocumentStore.getState().layers[0]!.opacity).toBe(100);

      state.setLayerOpacity(layerId, -10);
      expect(useDocumentStore.getState().layers[0]!.opacity).toBe(0);
    });
  });

  describe('setLayerBlendMode', () => {
    beforeEach(() => {
      useDocumentStore.getState().initDocument({ width: 800, height: 600, dpi: 72 });
    });

    it('should set layer blend mode', () => {
      const state = useDocumentStore.getState();
      const firstLayer = state.layers[0];
      expect(firstLayer).toBeDefined();
      const layerId = firstLayer!.id;

      state.setLayerBlendMode(layerId, 'multiply');

      expect(useDocumentStore.getState().layers[0]!.blendMode).toBe('multiply');
    });
  });

  describe('renameLayer', () => {
    beforeEach(() => {
      useDocumentStore.getState().initDocument({ width: 800, height: 600, dpi: 72 });
    });

    it('should rename the layer', () => {
      const state = useDocumentStore.getState();
      const firstLayer = state.layers[0];
      expect(firstLayer).toBeDefined();
      const layerId = firstLayer!.id;

      state.renameLayer(layerId, 'New Name');

      expect(useDocumentStore.getState().layers[0]!.name).toBe('New Name');
    });
  });

  describe('moveLayer', () => {
    beforeEach(() => {
      const store = useDocumentStore.getState();
      store.initDocument({ width: 800, height: 600, dpi: 72 });
      store.addLayer({ name: 'Layer 1', type: 'raster' });
      store.addLayer({ name: 'Layer 2', type: 'raster' });
    });

    it('should move layer to new position', () => {
      const state = useDocumentStore.getState();
      const thirdLayer = state.layers[2];
      expect(thirdLayer).toBeDefined();
      const layerId = thirdLayer!.id;

      state.moveLayer(layerId, 0);

      const newState = useDocumentStore.getState();
      expect(newState.layers[0]!.id).toBe(layerId);
    });

    it('should not move if target is same position', () => {
      const state = useDocumentStore.getState();
      const originalOrder = state.layers.map((l) => l.id);

      const secondLayer = state.layers[1];
      expect(secondLayer).toBeDefined();
      state.moveLayer(secondLayer!.id, 1);

      const newOrder = useDocumentStore.getState().layers.map((l) => l.id);
      expect(newOrder).toEqual(originalOrder);
    });
  });
});

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

      store.initDocument({ width: 1920, height: 1080, dpi: 72 });

      expect(store.width).toBe(1920);
      expect(store.height).toBe(1080);
      expect(store.dpi).toBe(72);
    });

    it('should create a default background layer', () => {
      const store = useDocumentStore.getState();

      store.initDocument({ width: 800, height: 600, dpi: 72 });

      expect(store.layers).toHaveLength(1);
      expect(store.layers[0].name).toBe('Background');
      expect(store.layers[0].type).toBe('raster');
    });

    it('should set the background layer as active', () => {
      const store = useDocumentStore.getState();

      store.initDocument({ width: 800, height: 600, dpi: 72 });

      expect(store.activeLayerId).toBe(store.layers[0].id);
    });
  });

  describe('addLayer', () => {
    beforeEach(() => {
      useDocumentStore.getState().initDocument({ width: 800, height: 600, dpi: 72 });
    });

    it('should add a new layer', () => {
      const store = useDocumentStore.getState();
      const initialCount = store.layers.length;

      store.addLayer({ name: 'New Layer', type: 'raster' });

      expect(store.layers.length).toBe(initialCount + 1);
    });

    it('should set new layer as active', () => {
      const store = useDocumentStore.getState();

      store.addLayer({ name: 'New Layer', type: 'raster' });

      const newLayer = store.layers[store.layers.length - 1];
      expect(store.activeLayerId).toBe(newLayer.id);
    });

    it('should create layer with correct properties', () => {
      const store = useDocumentStore.getState();

      store.addLayer({ name: 'Test Layer', type: 'raster' });

      const newLayer = store.layers[store.layers.length - 1];
      expect(newLayer.name).toBe('Test Layer');
      expect(newLayer.type).toBe('raster');
      expect(newLayer.visible).toBe(true);
      expect(newLayer.opacity).toBe(100);
      expect(newLayer.blendMode).toBe('normal');
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
      const store = useDocumentStore.getState();
      const layerToRemove = store.layers[1];
      const initialCount = store.layers.length;

      store.removeLayer(layerToRemove.id);

      expect(store.layers.length).toBe(initialCount - 1);
      expect(store.layers.find((l) => l.id === layerToRemove.id)).toBeUndefined();
    });

    it('should update active layer when removing active layer', () => {
      const store = useDocumentStore.getState();
      const activeId = store.activeLayerId!;

      store.removeLayer(activeId);

      expect(store.activeLayerId).not.toBe(activeId);
      expect(store.activeLayerId).toBeDefined();
    });
  });

  describe('toggleLayerVisibility', () => {
    beforeEach(() => {
      useDocumentStore.getState().initDocument({ width: 800, height: 600, dpi: 72 });
    });

    it('should toggle layer visibility', () => {
      const store = useDocumentStore.getState();
      const layer = store.layers[0];

      expect(layer.visible).toBe(true);

      store.toggleLayerVisibility(layer.id);
      expect(store.layers[0].visible).toBe(false);

      store.toggleLayerVisibility(layer.id);
      expect(store.layers[0].visible).toBe(true);
    });
  });

  describe('setLayerOpacity', () => {
    beforeEach(() => {
      useDocumentStore.getState().initDocument({ width: 800, height: 600, dpi: 72 });
    });

    it('should set layer opacity', () => {
      const store = useDocumentStore.getState();
      const layer = store.layers[0];

      store.setLayerOpacity(layer.id, 50);

      expect(store.layers[0].opacity).toBe(50);
    });

    it('should clamp opacity to valid range', () => {
      const store = useDocumentStore.getState();
      const layer = store.layers[0];

      store.setLayerOpacity(layer.id, 150);
      expect(store.layers[0].opacity).toBe(100);

      store.setLayerOpacity(layer.id, -10);
      expect(store.layers[0].opacity).toBe(0);
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
      const store = useDocumentStore.getState();
      const layerToMove = store.layers[2]; // Last layer

      store.moveLayer(layerToMove.id, 0);

      expect(store.layers[0].id).toBe(layerToMove.id);
    });
  });
});

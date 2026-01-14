import { describe, it, expect } from 'vitest';
import { useToolStore } from '../tool';

describe('ToolStore', () => {
  describe('setTool', () => {
    it('should change current tool', () => {
      const store = useToolStore.getState();

      store.setTool('eraser');
      expect(useToolStore.getState().currentTool).toBe('eraser');

      store.setTool('brush');
      expect(useToolStore.getState().currentTool).toBe('brush');
    });
  });

  describe('setBrushSize', () => {
    it('should set brush size', () => {
      const store = useToolStore.getState();

      store.setBrushSize(50);
      expect(useToolStore.getState().brushSize).toBe(50);
    });

    it('should clamp brush size to valid range', () => {
      const store = useToolStore.getState();

      store.setBrushSize(1000);
      expect(useToolStore.getState().brushSize).toBe(800); // Max is 800

      store.setBrushSize(0);
      expect(useToolStore.getState().brushSize).toBe(1);
    });
  });

  describe('setBrushOpacity', () => {
    it('should set brush opacity', () => {
      const store = useToolStore.getState();

      store.setBrushOpacity(0.5);
      expect(useToolStore.getState().brushOpacity).toBe(0.5);
    });

    it('should clamp opacity to valid range', () => {
      const store = useToolStore.getState();

      store.setBrushOpacity(2.0);
      expect(useToolStore.getState().brushOpacity).toBe(1);

      // Minimum opacity is 0.01 (not 0) to ensure brush is always visible
      store.setBrushOpacity(-0.5);
      expect(useToolStore.getState().brushOpacity).toBe(0.01);
    });
  });

  describe('swapColors', () => {
    it('should swap foreground and background colors', () => {
      const store = useToolStore.getState();

      store.setBrushColor('#ff0000');
      store.setBackgroundColor('#0000ff');

      store.swapColors();

      expect(useToolStore.getState().brushColor).toBe('#0000ff');
      expect(useToolStore.getState().backgroundColor).toBe('#ff0000');
    });
  });

  describe('resetColors', () => {
    it('should reset to default black/white', () => {
      const store = useToolStore.getState();

      store.setBrushColor('#ff0000');
      store.setBackgroundColor('#00ff00');

      store.resetColors();

      expect(useToolStore.getState().brushColor).toBe('#000000');
      expect(useToolStore.getState().backgroundColor).toBe('#ffffff');
    });
  });
});

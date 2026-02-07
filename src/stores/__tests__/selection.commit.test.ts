import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectionStore } from '../selection';

describe('SelectionStore commitSelection', () => {
  beforeEach(() => {
    const store = useSelectionStore.getState();
    store.deselectAll();
    store.setSelectionMode('new');
    store.setLassoMode('freehand');

    vi.spyOn(HTMLCanvasElement.prototype as any, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement
    ) {
      const canvas = this as HTMLCanvasElement;
      return {
        fillStyle: '#ffffff',
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        quadraticCurveTo: vi.fn(),
        bezierCurveTo: vi.fn(),
        closePath: vi.fn(),
        fill: vi.fn(),
        getImageData: vi.fn((_x = 0, _y = 0, w?: number, h?: number) => {
          const width = Math.max(1, Math.floor(w ?? canvas.width ?? 1));
          const height = Math.max(1, Math.floor(h ?? canvas.height ?? 1));
          return new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
        }),
      } as unknown as CanvasRenderingContext2D;
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('新建矩形选区时复用创建路径', () => {
    const store = useSelectionStore.getState();
    store.beginSelection({ x: 10, y: 20, type: 'polygonal' });
    store.updateCreationRect(
      { x: 10, y: 20, type: 'polygonal' },
      { x: 60, y: 80, type: 'polygonal' }
    );

    store.commitSelection(128, 128);

    const state = useSelectionStore.getState();
    expect(state.hasSelection).toBe(true);
    expect(state.selectionPath).toHaveLength(1);
    expect(state.selectionPath[0]).toHaveLength(5);
    expect(state.bounds).toEqual({ x: 10, y: 20, width: 50, height: 60 });
  });
});

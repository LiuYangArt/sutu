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
    useSelectionStore.getState().deselectAll();
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

  it('大画布新建选区时优先返回路径并进入异步 mask 构建', () => {
    const store = useSelectionStore.getState();
    store.beginSelection({ x: 120, y: 130, type: 'polygonal' });
    store.updateCreationRect(
      { x: 120, y: 130, type: 'polygonal' },
      { x: 180, y: 210, type: 'polygonal' }
    );

    store.commitSelection(5000, 5000);

    const state = useSelectionStore.getState();
    expect(state.hasSelection).toBe(true);
    expect(state.selectionPath).toHaveLength(1);
    expect(state.selectionMaskPending).toBe(true);
    expect(state.bounds).toEqual({ x: 120, y: 130, width: 60, height: 80 });
  });

  it('mask 未就绪时按 selectionPath 命中测试', () => {
    useSelectionStore.setState({
      hasSelection: true,
      selectionMask: null,
      selectionPath: [
        [
          { x: 10, y: 10, type: 'polygonal' },
          { x: 40, y: 10, type: 'polygonal' },
          { x: 40, y: 40, type: 'polygonal' },
          { x: 10, y: 40, type: 'polygonal' },
          { x: 10, y: 10, type: 'polygonal' },
        ],
      ],
      bounds: { x: 10, y: 10, width: 30, height: 30 },
    } as Partial<ReturnType<typeof useSelectionStore.getState>>);

    const state = useSelectionStore.getState();
    expect(state.isPointInSelection(20, 20)).toBe(true);
    expect(state.isPointInSelection(60, 60)).toBe(false);
  });

  it('布尔选区提交时先进入 pending 再异步回填最终 mask/path', async () => {
    const width = 64;
    const height = 64;
    const baseMask = new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
    for (let y = 8; y < 24; y += 1) {
      for (let x = 8; x < 24; x += 1) {
        const idx = (y * width + x) * 4;
        baseMask.data[idx] = 255;
        baseMask.data[idx + 1] = 255;
        baseMask.data[idx + 2] = 255;
        baseMask.data[idx + 3] = 255;
      }
    }

    useSelectionStore.setState({
      hasSelection: true,
      selectionMask: baseMask,
      selectionPath: [
        [
          { x: 8, y: 8, type: 'polygonal' },
          { x: 24, y: 8, type: 'polygonal' },
          { x: 24, y: 24, type: 'polygonal' },
          { x: 8, y: 24, type: 'polygonal' },
          { x: 8, y: 8, type: 'polygonal' },
        ],
      ],
      bounds: { x: 8, y: 8, width: 16, height: 16 },
    } as Partial<ReturnType<typeof useSelectionStore.getState>>);

    const store = useSelectionStore.getState();
    store.setSelectionMode('add');
    store.beginSelection({ x: 20, y: 20, type: 'polygonal' });
    store.updateCreationRect(
      { x: 20, y: 20, type: 'polygonal' },
      { x: 40, y: 40, type: 'polygonal' }
    );
    store.commitSelection(width, height);

    const pendingState = useSelectionStore.getState();
    expect(pendingState.selectionMaskPending).toBe(true);
    expect(pendingState.isCreating).toBe(false);
    expect(pendingState.creationPoints).toHaveLength(0);

    for (let i = 0; i < 20; i += 1) {
      if (!useSelectionStore.getState().selectionMaskPending) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    const doneState = useSelectionStore.getState();
    expect(doneState.selectionMaskPending).toBe(false);
    expect(doneState.hasSelection).toBe(true);
    expect(doneState.selectionMask).not.toBeNull();
    expect(doneState.selectionPath.length).toBeGreaterThan(0);
  });
});

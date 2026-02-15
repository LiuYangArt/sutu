import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSelectionHandler } from '../useSelectionHandler';
import { useDocumentStore } from '@/stores/document';
import { useHistoryStore } from '@/stores/history';
import { useSelectionStore } from '@/stores/selection';
import type { ToolType } from '@/stores/tool';

function createAltEvent(type: 'keydown' | 'keyup'): KeyboardEvent {
  return new KeyboardEvent(type, {
    code: 'AltLeft',
    key: 'Alt',
    bubbles: true,
    cancelable: true,
  });
}

function resetSelectionState(): void {
  useSelectionStore.getState().deselectAll();
  useSelectionStore.getState().setSelectionMode('new');
  useSelectionStore.getState().setLassoMode('freehand');
}

describe('useSelectionHandler', () => {
  beforeEach(() => {
    useDocumentStore.getState().reset();
    useDocumentStore.setState({ width: 256, height: 256 });
    useHistoryStore.getState().clear();
    resetSelectionState();

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement
    ) {
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
          const width = Math.max(1, Math.floor(w ?? this.width ?? 1));
          const height = Math.max(1, Math.floor(h ?? this.height ?? 1));
          return new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
        }),
      } as unknown as CanvasRenderingContext2D;
    } as unknown as HTMLCanvasElement['getContext']);
  });

  afterEach(() => {
    act(() => {
      useSelectionStore.getState().deselectAll();
    });
    vi.restoreAllMocks();
  });

  it('离开选区工具时会自动完成当前 lasso 选区', () => {
    const { result, rerender } = renderHook(
      ({ tool }) => useSelectionHandler({ currentTool: tool, scale: 1 }),
      { initialProps: { tool: 'lasso' as ToolType } }
    );

    act(() => {
      result.current.handleSelectionPointerDown(20, 20, {
        altKey: false,
        shiftKey: false,
        ctrlKey: false,
      } as PointerEvent);
      result.current.handleSelectionPointerMove(80, 20, {} as PointerEvent);
      result.current.handleSelectionPointerMove(80, 80, {} as PointerEvent);
      result.current.handleSelectionPointerMove(20, 80, {} as PointerEvent);
    });

    expect(useSelectionStore.getState().isCreating).toBe(true);

    act(() => {
      rerender({ tool: 'brush' as ToolType });
    });

    const state = useSelectionStore.getState();
    expect(state.isCreating).toBe(false);
    expect(state.hasSelection).toBe(true);
    expect(state.selectionPath.length).toBeGreaterThan(0);
  });

  it('选区工具下 Alt 按键会阻止默认行为，避免系统菜单抢焦点', () => {
    const { rerender } = renderHook(
      ({ tool }) => useSelectionHandler({ currentTool: tool, scale: 1 }),
      { initialProps: { tool: 'select' as ToolType } }
    );

    const altDown = createAltEvent('keydown');
    const altUp = createAltEvent('keyup');

    act(() => {
      window.dispatchEvent(altDown);
      window.dispatchEvent(altUp);
    });

    expect(altDown.defaultPrevented).toBe(true);
    expect(altUp.defaultPrevented).toBe(true);

    rerender({ tool: 'brush' as ToolType });

    const brushAltDown = createAltEvent('keydown');

    act(() => {
      window.dispatchEvent(brushAltDown);
    });

    expect(brushAltDown.defaultPrevented).toBe(false);
  });

  it('窗口失焦时会重置 Alt 状态，避免 lasso 卡在 polygonal 模式', () => {
    const { result } = renderHook(() => useSelectionHandler({ currentTool: 'lasso', scale: 1 }));

    const altDown = createAltEvent('keydown');

    act(() => {
      window.dispatchEvent(altDown);
    });
    expect(result.current.effectiveLassoMode).toBe('polygonal');

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(result.current.effectiveLassoMode).toBe('freehand');
  });

  it('Alt 拖拽切换到 freehand 后，后续 move 不应重复插入 polygonal 锚点', () => {
    const { result } = renderHook(() => useSelectionHandler({ currentTool: 'lasso', scale: 1 }));

    act(() => {
      window.dispatchEvent(createAltEvent('keydown'));

      result.current.handleSelectionPointerDown(10, 10, {
        altKey: true,
        shiftKey: false,
        ctrlKey: false,
      } as PointerEvent);

      // 第一次 move 仅记录拖拽起点；第二次触发 polygonal -> freehand 切换
      result.current.handleSelectionPointerMove(20, 20, {} as PointerEvent);
      result.current.handleSelectionPointerMove(30, 30, {} as PointerEvent);

      // 切换后应持续记录 freehand 点，而不是再次注入 polygonal 锚点
      result.current.handleSelectionPointerMove(40, 40, {} as PointerEvent);
      result.current.handleSelectionPointerMove(50, 50, {} as PointerEvent);
    });

    const path = useSelectionStore.getState().creationPoints;
    expect(path.map((p) => p.type)).toEqual([
      'polygonal',
      'polygonal',
      'freehand',
      'freehand',
      'freehand',
    ]);
  });

  it('自动填色回调成功时，不额外写入 selection 历史', async () => {
    const onSelectionCommitted = vi.fn(async () => true);
    const { result } = renderHook(() =>
      useSelectionHandler({
        currentTool: 'select',
        scale: 1,
        onSelectionCommitted,
      })
    );

    act(() => {
      result.current.handleSelectionPointerDown(10, 10, {
        altKey: false,
        shiftKey: false,
        ctrlKey: false,
      } as PointerEvent);
      result.current.handleSelectionPointerMove(80, 60, {} as PointerEvent);
      result.current.handleSelectionPointerUp(80, 60);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(onSelectionCommitted).toHaveBeenCalledTimes(1);
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });

  it('提交选区时会先触发 onSelectionCommitStart 以锁定预览路径', () => {
    const onSelectionCommitStart = vi.fn();
    const { result } = renderHook(() =>
      useSelectionHandler({
        currentTool: 'select',
        scale: 1,
        onSelectionCommitStart,
      })
    );

    act(() => {
      result.current.handleSelectionPointerDown(10, 10, {
        altKey: false,
        shiftKey: false,
        ctrlKey: false,
      } as PointerEvent);
      result.current.handleSelectionPointerMove(64, 48, {} as PointerEvent);
      result.current.handleSelectionPointerUp(64, 48);
    });

    expect(onSelectionCommitStart).toHaveBeenCalledTimes(1);
    const payload = onSelectionCommitStart.mock.calls[0]?.[0] as
      | { path: Array<{ x: number; y: number }>; mode: string }
      | undefined;
    expect(payload?.path.length).toBeGreaterThanOrEqual(3);
    expect(payload?.mode).toBe('new');
  });

  it('自动填色回调失败时，回退为 selection 历史记录', async () => {
    const onSelectionCommitted = vi.fn(async () => false);
    const { result } = renderHook(() =>
      useSelectionHandler({
        currentTool: 'select',
        scale: 1,
        onSelectionCommitted,
      })
    );

    act(() => {
      result.current.handleSelectionPointerDown(12, 12, {
        altKey: false,
        shiftKey: false,
        ctrlKey: false,
      } as PointerEvent);
      result.current.handleSelectionPointerMove(70, 50, {} as PointerEvent);
      result.current.handleSelectionPointerUp(70, 50);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(onSelectionCommitted).toHaveBeenCalledTimes(1);
    const undoStack = useHistoryStore.getState().undoStack;
    const lastEntry = undoStack[undoStack.length - 1];
    expect(lastEntry?.type).toBe('selection');
  });
});

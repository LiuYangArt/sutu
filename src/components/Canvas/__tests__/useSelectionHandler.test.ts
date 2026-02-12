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
});

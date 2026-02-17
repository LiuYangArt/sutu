import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import { usePointerHandlers } from '../usePointerHandlers';
import type { ToolType } from '@/stores/tool';

interface HookContext {
  container: HTMLDivElement;
  canvas: HTMLCanvasElement;
  containerRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}

function createNativePointerEvent(
  init: Partial<PointerEvent> & {
    pointerId?: number;
    clientX?: number;
    clientY?: number;
    pointerType?: string;
    pressure?: number;
    isTrusted?: boolean;
  } = {}
): PointerEvent {
  const event = {
    pointerId: init.pointerId ?? 1,
    clientX: init.clientX ?? 12,
    clientY: init.clientY ?? 18,
    pointerType: init.pointerType ?? 'pen',
    pressure: init.pressure ?? 0.5,
    tiltX: init.tiltX ?? 0,
    tiltY: init.tiltY ?? 0,
    twist: init.twist ?? 0,
    button: init.button ?? 0,
    buttons: init.buttons ?? 1,
    isPrimary: init.isPrimary ?? true,
    isTrusted: init.isTrusted ?? true,
    getCoalescedEvents: init.getCoalescedEvents ?? (() => []),
  } as unknown as PointerEvent;
  return event;
}

function createReactPointerEvent(nativeEvent: PointerEvent): React.PointerEvent {
  return {
    pointerId: nativeEvent.pointerId,
    clientX: nativeEvent.clientX,
    clientY: nativeEvent.clientY,
    nativeEvent,
    button: nativeEvent.button,
    buttons: nativeEvent.buttons,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.PointerEvent;
}

function createHookContext(): HookContext {
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);

  Object.assign(container, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    focus: vi.fn(),
  });
  canvas.getBoundingClientRect = vi.fn(
    () =>
      ({
        left: 0,
        top: 0,
        width: 512,
        height: 512,
        right: 512,
        bottom: 512,
      }) as DOMRect
  );

  return {
    container,
    canvas,
    containerRef: { current: container },
    canvasRef: { current: canvas },
  };
}

function createHookParams(ctx: HookContext, tool: ToolType = 'brush') {
  return {
    containerRef: ctx.containerRef,
    canvasRef: ctx.canvasRef,
    layerRendererRef: { current: null },
    useGpuDisplay: false,
    sampleGpuPixelColor: undefined,
    currentTool: tool,
    scale: 1,
    spacePressed: false,
    isPanning: false,
    setIsPanning: vi.fn(),
    panStartRef: { current: null },
    pan: vi.fn(),
    isZoomingRef: { current: false },
    zoomStartRef: { current: null },
    setScale: vi.fn(),
    setBrushColor: vi.fn(),
    width: 512,
    height: 512,
    layers: [{ id: 'layer-1', visible: true }] as Array<{ id: string; visible: boolean }>,
    activeLayerId: 'layer-1',
    captureBeforeImage: vi.fn(async () => undefined),
    initializeBrushStroke: vi.fn(async () => undefined),
    finishCurrentStroke: vi.fn(async () => undefined),
    isSelectionToolActive: false,
    handleSelectionPointerDown: vi.fn(() => false),
    handleSelectionPointerMove: vi.fn(),
    handleSelectionPointerUp: vi.fn(),
    handleMovePointerDown: vi.fn(() => false),
    handleMovePointerMove: vi.fn(() => false),
    handleMovePointerUp: vi.fn(() => false),
    handleGradientPointerDown: vi.fn(() => false),
    handleGradientPointerMove: vi.fn(),
    handleGradientPointerUp: vi.fn(),
    updateShiftLineCursor: vi.fn(),
    lockShiftLine: vi.fn(),
    constrainShiftLinePoint: vi.fn((x: number, y: number) => ({ x, y })),
    usingRawInput: { current: false },
    isDrawingRef: { current: false },
    strokeStateRef: { current: 'idle' },
    pendingPointsRef: { current: [] },
    inputQueueRef: { current: [] },
    pointIndexRef: { current: 0 },
    pendingEndRef: { current: false },
    lastInputPosRef: { current: null },
    latencyProfilerRef: { current: { markInputReceived: vi.fn() } },
    onBeforeCanvasMutation: vi.fn(),
  };
}

describe('usePointerHandlers', () => {
  it('captures pointer on canvas container for stroke start', () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');

    const { result } = renderHook(() => usePointerHandlers(params as any));
    const down = createReactPointerEvent(createNativePointerEvent({ pointerId: 21 }));

    act(() => {
      result.current.handlePointerDown(down);
    });

    expect((ctx.container as any).setPointerCapture).toHaveBeenCalledWith(21);
  });

  it('releases capture and finishes stroke on pointer cancel', () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');

    const { result } = renderHook(() => usePointerHandlers(params as any));
    const down = createReactPointerEvent(createNativePointerEvent({ pointerId: 7 }));
    const cancel = createReactPointerEvent(createNativePointerEvent({ pointerId: 7 }));

    act(() => {
      result.current.handlePointerDown(down);
    });
    act(() => {
      result.current.handlePointerCancel(cancel);
    });

    expect((ctx.container as any).releasePointerCapture).toHaveBeenCalledWith(7);
    expect(params.finishCurrentStroke).toHaveBeenCalledTimes(1);
  });

  it('ignores non-active pointer move events', () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');

    const { result } = renderHook(() => usePointerHandlers(params as any));
    const down = createReactPointerEvent(createNativePointerEvent({ pointerId: 1 }));
    const wrongMove = createReactPointerEvent(
      createNativePointerEvent({ pointerId: 2, clientX: 100, clientY: 100 })
    );
    const rightMove = createReactPointerEvent(
      createNativePointerEvent({ pointerId: 1, clientX: 80, clientY: 80 })
    );

    act(() => {
      result.current.handlePointerDown(down);
    });
    vi.mocked(params.updateShiftLineCursor).mockClear();

    act(() => {
      result.current.handlePointerMove(wrongMove);
    });
    expect(params.updateShiftLineCursor).not.toHaveBeenCalled();

    act(() => {
      result.current.handlePointerMove(rightMove);
    });
    expect(params.updateShiftLineCursor).toHaveBeenCalled();
  });

  it('uses window fallback pointerup to finish active session', () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');

    const { result } = renderHook(() => usePointerHandlers(params as any));
    const down = createReactPointerEvent(createNativePointerEvent({ pointerId: 33 }));

    act(() => {
      result.current.handlePointerDown(down);
    });

    vi.mocked(params.finishCurrentStroke).mockClear();
    vi.mocked((ctx.container as any).releasePointerCapture).mockClear();

    const windowPointerUp = new Event('pointerup') as PointerEvent;
    Object.defineProperty(windowPointerUp, 'pointerId', { value: 33 });
    Object.defineProperty(windowPointerUp, 'button', { value: 0 });
    Object.defineProperty(windowPointerUp, 'buttons', { value: 0 });
    Object.defineProperty(windowPointerUp, 'clientX', { value: 20 });
    Object.defineProperty(windowPointerUp, 'clientY', { value: 20 });

    act(() => {
      window.dispatchEvent(windowPointerUp);
    });

    expect((ctx.container as any).releasePointerCapture).toHaveBeenCalledWith(33);
    expect(params.finishCurrentStroke).toHaveBeenCalledTimes(1);
  });
});

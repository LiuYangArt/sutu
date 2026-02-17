import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import type { ToolType } from '@/stores/tool';

const mockReadPointBufferSince = vi.fn();
const mockTabletStoreGetState = vi.fn();

vi.mock('@/stores/tablet', () => ({
  readPointBufferSince: (...args: unknown[]) => mockReadPointBufferSince(...args),
  useTabletStore: {
    getState: () => mockTabletStoreGetState(),
  },
}));

import { usePointerHandlers } from '../usePointerHandlers';

interface HookContext {
  container: HTMLDivElement;
  canvas: HTMLCanvasElement;
  containerRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}

const DEFAULT_TABLET_STATE = {
  backend: 'pointerevent',
  activeBackend: 'pointerevent',
  isStreaming: false,
  currentPoint: null,
};

function createTabletPoint(args: {
  seq: number;
  pressure: number;
  phase: 'down' | 'move' | 'up';
  x?: number;
  y?: number;
  timestampMs?: number;
}) {
  return {
    seq: args.seq,
    stream_id: 1,
    source: 'wintab',
    pointer_id: 1,
    phase: args.phase,
    x: args.x ?? 10,
    y: args.y ?? 10,
    pressure: args.pressure,
    tilt_x: 0,
    tilt_y: 0,
    rotation: 0,
    timestamp_ms: args.timestampMs ?? args.seq,
    host_time_us: 0,
    device_time_us: 0,
  };
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

beforeEach(() => {
  vi.useRealTimers();
  mockReadPointBufferSince.mockReset();
  mockTabletStoreGetState.mockReset();
  mockReadPointBufferSince.mockReturnValue({ points: [], nextSeq: 0 });
  mockTabletStoreGetState.mockReturnValue(DEFAULT_TABLET_STATE);
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushPointerupGraceWindow(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(4);
    await Promise.resolve();
  });
  await act(async () => {
    vi.advanceTimersByTime(4);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
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

  it('releases capture and finishes stroke on pointer cancel', async () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');

    const { result } = renderHook(() => usePointerHandlers(params as any));
    const down = createReactPointerEvent(createNativePointerEvent({ pointerId: 7 }));
    const cancel = createReactPointerEvent(createNativePointerEvent({ pointerId: 7 }));

    act(() => {
      result.current.handlePointerDown(down);
    });
    await act(async () => {
      result.current.handlePointerCancel(cancel);
      await Promise.resolve();
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

  it('uses window fallback pointerup to finish active session', async () => {
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

    await act(async () => {
      window.dispatchEvent(windowPointerUp);
      await Promise.resolve();
    });

    expect((ctx.container as any).releasePointerCapture).toHaveBeenCalledWith(33);
    expect(params.finishCurrentStroke).toHaveBeenCalledTimes(1);
  });

  it('applies pointerup fallback pressure policy: last_nonzero > event_raw > zero', async () => {
    vi.useFakeTimers();
    mockTabletStoreGetState.mockReturnValue({
      backend: 'wintab',
      activeBackend: 'wintab',
      isStreaming: true,
      currentPoint: null,
    });
    mockReadPointBufferSince
      .mockReturnValueOnce({
        points: [createTabletPoint({ seq: 10, pressure: 0.22, phase: 'move', x: 40, y: 50 })],
        nextSeq: 10,
      })
      .mockReturnValueOnce({ points: [], nextSeq: 10 })
      .mockReturnValueOnce({ points: [], nextSeq: 10 });

    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));
    const down = createReactPointerEvent(createNativePointerEvent({ pointerId: 5, pressure: 0.4 }));
    const up = createReactPointerEvent(createNativePointerEvent({ pointerId: 5, pressure: 0 }));

    act(() => {
      result.current.handlePointerDown(down);
    });
    const pointBeforeUp = params.pendingPointsRef.current[
      params.pendingPointsRef.current.length - 1
    ] as { x: number; y: number } | undefined;
    act(() => {
      result.current.handlePointerUp(up);
    });

    expect(params.finishCurrentStroke).not.toHaveBeenCalled();
    await flushPointerupGraceWindow();

    expect(params.finishCurrentStroke).toHaveBeenCalledTimes(1);
    const fallbackPoint = params.pendingPointsRef.current[params.pendingPointsRef.current.length - 1] as
      | {
          traceSource?: string;
          fallbackPressurePolicy?: string;
          pressure: number;
          phase: string;
          x: number;
          y: number;
        }
      | undefined;
    expect(fallbackPoint?.traceSource).toBe('pointerup_fallback');
    expect(fallbackPoint?.fallbackPressurePolicy).toBe('last_nonzero');
    expect(fallbackPoint?.pressure).toBeCloseTo(0.22, 6);
    expect(fallbackPoint?.phase).toBe('up');
    expect(fallbackPoint?.x).toBeCloseTo(pointBeforeUp?.x ?? 0, 6);
    expect(fallbackPoint?.y).toBeCloseTo(pointBeforeUp?.y ?? 0, 6);
  });

  it('keeps pointerup fallback position at last stroke point instead of far pointerup coords', async () => {
    vi.useFakeTimers();
    mockTabletStoreGetState.mockReturnValue({
      backend: 'wintab',
      activeBackend: 'wintab',
      isStreaming: true,
      currentPoint: null,
    });
    mockReadPointBufferSince
      .mockReturnValueOnce({ points: [], nextSeq: 0 })
      .mockReturnValueOnce({ points: [], nextSeq: 0 })
      .mockReturnValueOnce({ points: [], nextSeq: 0 });

    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));
    const down = createReactPointerEvent(
      createNativePointerEvent({ pointerId: 21, pressure: 0, clientX: 16, clientY: 24 })
    );
    act(() => {
      result.current.handlePointerDown(down);
    });
    const pointBeforeUp = params.pendingPointsRef.current[
      params.pendingPointsRef.current.length - 1
    ] as { x: number; y: number } | undefined;

    const farUp = createReactPointerEvent(
      createNativePointerEvent({ pointerId: 21, pressure: 0, clientX: 4096, clientY: 4096 })
    );
    act(() => {
      result.current.handlePointerUp(farUp);
    });
    await flushPointerupGraceWindow();

    const fallbackPoint = params.pendingPointsRef.current[params.pendingPointsRef.current.length - 1] as
      | {
          x: number;
          y: number;
          fallbackPressurePolicy?: string;
        }
      | undefined;
    expect(fallbackPoint?.fallbackPressurePolicy).toBe('zero');
    expect(fallbackPoint?.x).toBeCloseTo(pointBeforeUp?.x ?? 0, 6);
    expect(fallbackPoint?.y).toBeCloseTo(pointBeforeUp?.y ?? 0, 6);
  });

  it('falls back to event_raw and zero policies when last_nonzero is unavailable', async () => {
    vi.useFakeTimers();
    mockTabletStoreGetState.mockReturnValue({
      backend: 'wintab',
      activeBackend: 'wintab',
      isStreaming: true,
      currentPoint: null,
    });

    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));
    const down = createReactPointerEvent(createNativePointerEvent({ pointerId: 8, pressure: 0 }));
    act(() => {
      result.current.handlePointerDown(down);
    });

    mockReadPointBufferSince.mockReset();
    mockReadPointBufferSince
      .mockReturnValueOnce({ points: [], nextSeq: 0 })
      .mockReturnValueOnce({ points: [], nextSeq: 0 })
      .mockReturnValueOnce({ points: [], nextSeq: 0 });
    const upEventRaw = createReactPointerEvent(
      createNativePointerEvent({ pointerId: 8, pressure: 0.33 })
    );
    act(() => {
      result.current.handlePointerUp(upEventRaw);
    });
    await flushPointerupGraceWindow();

    const fallbackFromEventRaw = params.pendingPointsRef.current[
      params.pendingPointsRef.current.length - 1
    ] as
      | {
          fallbackPressurePolicy?: string;
          pressure: number;
        }
      | undefined;
    expect(fallbackFromEventRaw?.fallbackPressurePolicy).toBe('event_raw');
    expect(fallbackFromEventRaw?.pressure).toBeCloseTo(0.33, 6);

    const ctx2 = createHookContext();
    const params2 = createHookParams(ctx2, 'brush');
    const { result: result2 } = renderHook(() => usePointerHandlers(params2 as any));
    mockReadPointBufferSince.mockReset();
    mockReadPointBufferSince.mockReturnValue({ points: [], nextSeq: 0 });
    const down2 = createReactPointerEvent(createNativePointerEvent({ pointerId: 9, pressure: 0 }));
    act(() => {
      result2.current.handlePointerDown(down2);
    });
    const upZero = createReactPointerEvent(createNativePointerEvent({ pointerId: 9, pressure: 0 }));
    mockReadPointBufferSince.mockReset();
    mockReadPointBufferSince
      .mockReturnValueOnce({ points: [], nextSeq: 0 })
      .mockReturnValueOnce({ points: [], nextSeq: 0 })
      .mockReturnValueOnce({ points: [], nextSeq: 0 });
    act(() => {
      result2.current.handlePointerUp(upZero);
    });
    await flushPointerupGraceWindow();

    const fallbackZero = params2.pendingPointsRef.current[
      params2.pendingPointsRef.current.length - 1
    ] as
      | {
          fallbackPressurePolicy?: string;
          pressure: number;
        }
      | undefined;
    expect(fallbackZero?.fallbackPressurePolicy).toBe('zero');
    expect(fallbackZero?.pressure).toBe(0);
  });

  it('waits grace window and uses finalize token to cancel stale pointerup finalize', async () => {
    vi.useFakeTimers();
    mockTabletStoreGetState.mockReturnValue({
      backend: 'wintab',
      activeBackend: 'wintab',
      isStreaming: true,
      currentPoint: null,
    });
    mockReadPointBufferSince.mockReturnValue({ points: [], nextSeq: 0 });

    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));
    const down = createReactPointerEvent(createNativePointerEvent({ pointerId: 11, pressure: 0.2 }));
    act(() => {
      result.current.handlePointerDown(down);
    });

    const up1 = createReactPointerEvent(createNativePointerEvent({ pointerId: 11, pressure: 0 }));
    const up2 = createReactPointerEvent(createNativePointerEvent({ pointerId: 11, pressure: 0 }));

    act(() => {
      result.current.handlePointerUp(up1);
    });
    expect(params.finishCurrentStroke).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(7);
      await Promise.resolve();
    });
    expect(params.finishCurrentStroke).not.toHaveBeenCalled();

    act(() => {
      result.current.handlePointerUp(up2);
    });
    await flushPointerupGraceWindow();

    expect(params.finishCurrentStroke).toHaveBeenCalledTimes(1);
  });

  it('ignores hover move events during pointerup finalize grace window', async () => {
    vi.useFakeTimers();
    mockTabletStoreGetState.mockReturnValue({
      backend: 'wintab',
      activeBackend: 'wintab',
      isStreaming: true,
      currentPoint: null,
    });
    mockReadPointBufferSince.mockReturnValue({ points: [], nextSeq: 0 });

    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));
    const down = createReactPointerEvent(
      createNativePointerEvent({
        pointerId: 41,
        pressure: 0.4,
        clientX: 24,
        clientY: 24,
        buttons: 1,
      })
    );
    act(() => {
      result.current.handlePointerDown(down);
    });
    const pointBeforeUp = params.pendingPointsRef.current[
      params.pendingPointsRef.current.length - 1
    ] as { x: number; y: number } | undefined;

    const up = createReactPointerEvent(
      createNativePointerEvent({
        pointerId: 41,
        pressure: 0,
        clientX: 24,
        clientY: 24,
        buttons: 0,
      })
    );
    act(() => {
      result.current.handlePointerUp(up);
    });

    const farHoverMove = createReactPointerEvent(
      createNativePointerEvent({
        pointerId: 41,
        pressure: 0,
        clientX: 4096,
        clientY: 4096,
        buttons: 0,
      })
    );
    act(() => {
      result.current.handlePointerMove(farHoverMove);
    });
    await flushPointerupGraceWindow();

    const tailPoint = params.pendingPointsRef.current[params.pendingPointsRef.current.length - 1] as
      | {
          x: number;
          y: number;
          phase?: string;
        }
      | undefined;
    expect(tailPoint?.x).toBeCloseTo(pointBeforeUp?.x ?? 0, 6);
    expect(tailPoint?.y).toBeCloseTo(pointBeforeUp?.y ?? 0, 6);
    expect(tailPoint?.phase).toBe('up');
    expect(tailPoint?.x).not.toBeCloseTo(4096, 6);
    expect(tailPoint?.y).not.toBeCloseTo(4096, 6);
  });

  it('stops native pointerup grace consumption at terminal hover/up boundary', async () => {
    vi.useFakeTimers();
    mockTabletStoreGetState.mockReturnValue({
      backend: 'wintab',
      activeBackend: 'wintab',
      isStreaming: true,
      currentPoint: null,
    });

    mockReadPointBufferSince
      .mockReturnValueOnce({ points: [], nextSeq: 0 })
      .mockReturnValueOnce({
        points: [
          createTabletPoint({ seq: 21, pressure: 0.2, phase: 'move', x: 40, y: 40 }),
          createTabletPoint({ seq: 22, pressure: 0, phase: 'move', x: 41, y: 41 }),
          createTabletPoint({ seq: 23, pressure: 0.7, phase: 'move', x: 400, y: 400 }),
        ],
        nextSeq: 23,
      })
      .mockReturnValue({ points: [], nextSeq: 23 });

    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));

    const down = createReactPointerEvent(createNativePointerEvent({ pointerId: 31, pressure: 0.5 }));
    act(() => {
      result.current.handlePointerDown(down);
    });
    const pointBeforeUp = params.pendingPointsRef.current[
      params.pendingPointsRef.current.length - 1
    ] as { x: number; y: number } | undefined;
    const up = createReactPointerEvent(createNativePointerEvent({ pointerId: 31, pressure: 0 }));
    act(() => {
      result.current.handlePointerUp(up);
    });
    await flushPointerupGraceWindow();

    const lastQueued = params.pendingPointsRef.current[params.pendingPointsRef.current.length - 1] as
      | {
          x: number;
          y: number;
          traceSource?: string;
          phase?: string;
        }
      | undefined;
    expect(lastQueued?.x).toBeCloseTo(pointBeforeUp?.x ?? 0, 6);
    expect(lastQueued?.y).toBeCloseTo(pointBeforeUp?.y ?? 0, 6);
    expect(lastQueued?.phase).toBe('up');
    expect(lastQueued?.traceSource).not.toBe('pointerup_fallback');
    expect(lastQueued?.x).not.toBeCloseTo(400, 6);
    expect(lastQueued?.y).not.toBeCloseTo(400, 6);
  });
});

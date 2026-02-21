import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import type { ToolType } from '@/stores/tool';
import type { TabletInputPoint } from '@/stores/tablet';

const readPointBufferSinceMock = vi.fn();
const getTabletStateMock = vi.fn();

vi.mock('@/stores/tablet', () => ({
  readPointBufferSince: (...args: unknown[]) => readPointBufferSinceMock(...args),
  useTabletStore: {
    getState: () => getTabletStateMock(),
  },
}));

import { usePointerHandlers } from '../usePointerHandlers';

interface HookContext {
  container: HTMLDivElement;
  canvas: HTMLCanvasElement;
  containerRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}

function createNativePoint(partial: Partial<TabletInputPoint>): TabletInputPoint {
  return {
    seq: partial.seq ?? 1,
    stroke_id: partial.stroke_id ?? 1,
    pointer_id: partial.pointer_id ?? 1,
    device_id: partial.device_id ?? 'tablet',
    source: partial.source ?? 'wintab',
    phase: partial.phase ?? 'move',
    x_px: partial.x_px ?? 0,
    y_px: partial.y_px ?? 0,
    pressure_0_1: partial.pressure_0_1 ?? 0.5,
    tilt_x_deg: partial.tilt_x_deg ?? 0,
    tilt_y_deg: partial.tilt_y_deg ?? 0,
    rotation_deg: partial.rotation_deg ?? 0,
    host_time_us: partial.host_time_us ?? 1000,
    device_time_us: partial.device_time_us ?? 1000,
    x: partial.x ?? partial.x_px ?? 0,
    y: partial.y ?? partial.y_px ?? 0,
    pressure: partial.pressure ?? partial.pressure_0_1 ?? 0.5,
    tilt_x: partial.tilt_x ?? partial.tilt_x_deg ?? 0,
    tilt_y: partial.tilt_y ?? partial.tilt_y_deg ?? 0,
    rotation: partial.rotation ?? partial.rotation_deg ?? 0,
    timestamp_ms: partial.timestamp_ms ?? 1,
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
    type: init.type ?? 'pointermove',
    timeStamp: init.timeStamp ?? 1,
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
  canvas.width = 512;
  canvas.height = 512;
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
    pendingPointsRef: { current: [] as Array<Record<string, unknown>> },
    inputQueueRef: { current: [] as Array<Record<string, unknown>> },
    pointIndexRef: { current: 0 },
    pendingEndRef: { current: false },
    lastInputPosRef: { current: null },
    latencyProfilerRef: { current: { markInputReceived: vi.fn() } },
    onBeforeCanvasMutation: vi.fn(),
  };
}

describe('usePointerHandlers native geometry path', () => {
  beforeEach(() => {
    readPointBufferSinceMock.mockReset();
    getTabletStateMock.mockReset();
    getTabletStateMock.mockReturnValue({
      isStreaming: true,
      backend: 'wintab',
      activeBackend: 'wintab',
      currentPoint: null,
    });
  });

  it('uses native x_px/y_px geometry in wintab mode', () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));

    readPointBufferSinceMock
      .mockReturnValueOnce({
        points: [
          createNativePoint({ seq: 1, phase: 'down', x_px: 100, y_px: 120, pressure_0_1: 0.2 }),
        ],
        nextSeq: 1,
      })
      .mockReturnValueOnce({
        points: [
          createNativePoint({ seq: 2, phase: 'move', x_px: 240, y_px: 260, pressure_0_1: 0.35 }),
        ],
        nextSeq: 2,
      });

    act(() => {
      result.current.handlePointerDown(
        createReactPointerEvent(
          createNativePointerEvent({ pointerId: 1, clientX: 10, clientY: 10 })
        )
      );
    });

    act(() => {
      result.current.handlePointerMove(
        createReactPointerEvent(
          createNativePointerEvent({ pointerId: 1, clientX: 400, clientY: 420 })
        )
      );
    });

    const tail = params.pendingPointsRef.current[params.pendingPointsRef.current.length - 1] as
      | { x: number; y: number; pressure: number; source: string }
      | undefined;
    expect(tail).toBeDefined();
    expect(tail?.x).toBeCloseTo(240, 6);
    expect(tail?.y).toBeCloseTo(260, 6);
    expect(tail?.pressure).toBeCloseTo(0.35, 6);
    expect(tail?.source).toBe('wintab');
  });

  it('consumes native seed by stroke_id even when native pointer_id differs from DOM pointer', () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));

    readPointBufferSinceMock.mockReturnValueOnce({
      points: [
        createNativePoint({
          seq: 1,
          stroke_id: 88,
          pointer_id: 99,
          phase: 'down',
          x_px: 150,
          y_px: 170,
          pressure_0_1: 0.3,
        }),
      ],
      nextSeq: 1,
      bufferEpoch: 0,
    });

    act(() => {
      result.current.handlePointerDown(
        createReactPointerEvent(
          createNativePointerEvent({
            pointerId: 1,
            clientX: 40,
            clientY: 60,
            type: 'pointerdown',
          })
        )
      );
    });

    const seed = params.pendingPointsRef.current[0] as
      | { x: number; y: number; pressure: number }
      | undefined;
    expect(seed).toBeDefined();
    expect(seed?.x).toBeCloseTo(150, 6);
    expect(seed?.y).toBeCloseTo(170, 6);
    expect(seed?.pressure).toBeCloseTo(0.3, 6);
  });

  it('queues explicit native up sample and does not use pointerup geometry patch', () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));

    readPointBufferSinceMock
      .mockReturnValueOnce({
        points: [
          createNativePoint({ seq: 1, phase: 'down', x_px: 60, y_px: 70, pressure_0_1: 0.3 }),
        ],
        nextSeq: 1,
      })
      .mockReturnValueOnce({
        points: [createNativePoint({ seq: 2, phase: 'up', x_px: 300, y_px: 320, pressure_0_1: 0 })],
        nextSeq: 2,
      });

    act(() => {
      result.current.handlePointerDown(
        createReactPointerEvent(
          createNativePointerEvent({ pointerId: 1, clientX: 10, clientY: 10 })
        )
      );
    });

    params.strokeStateRef.current = 'active';
    params.isDrawingRef.current = true;
    params.inputQueueRef.current = [];

    act(() => {
      result.current.handlePointerUp(
        createReactPointerEvent(
          createNativePointerEvent({
            pointerId: 1,
            clientX: 900,
            clientY: 920,
            type: 'pointerup',
            pressure: 0,
          })
        )
      );
    });

    const queue = params.inputQueueRef.current as Array<{ phase: string; x: number; y: number }>;
    expect(queue.length).toBeGreaterThan(0);
    const tail = queue[queue.length - 1];
    expect(tail?.phase).toBe('up');
    expect(tail?.x).toBeCloseTo(300, 6);
    expect(tail?.y).toBeCloseTo(320, 6);
  });

  it('uses pointer geometry in pointerevent mode', () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));

    getTabletStateMock.mockReturnValue({
      isStreaming: true,
      backend: 'pointerevent',
      activeBackend: 'pointerevent',
      currentPoint: null,
    });
    readPointBufferSinceMock.mockReturnValue({ points: [], nextSeq: 0 });

    act(() => {
      result.current.handlePointerDown(
        createReactPointerEvent(
          createNativePointerEvent({ pointerId: 1, clientX: 100, clientY: 120 })
        )
      );
    });

    params.strokeStateRef.current = 'active';
    params.isDrawingRef.current = true;
    params.inputQueueRef.current = [];

    act(() => {
      result.current.handlePointerMove(
        createReactPointerEvent(
          createNativePointerEvent({ pointerId: 1, clientX: 220, clientY: 260 })
        )
      );
    });

    const queue = params.inputQueueRef.current as Array<{ x: number; y: number; source: string }>;
    expect(queue).toHaveLength(1);
    expect(queue[0]?.x).toBeCloseTo(220, 6);
    expect(queue[0]?.y).toBeCloseTo(260, 6);
    expect(queue[0]?.source).toBe('pointerevent');
  });

  it('ignores stale native up-only seed on pointerdown', async () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));

    readPointBufferSinceMock.mockReturnValueOnce({
      points: [createNativePoint({ seq: 27, stroke_id: 1, phase: 'up', x_px: 480, y_px: 484 })],
      nextSeq: 27,
    });

    await act(async () => {
      result.current.handlePointerDown(
        createReactPointerEvent(
          createNativePointerEvent({
            pointerId: 1,
            clientX: 120,
            clientY: 140,
            type: 'pointerdown',
          })
        )
      );
      await Promise.resolve();
    });

    expect(params.pendingPointsRef.current).toHaveLength(0);
    expect(params.lockShiftLine).toHaveBeenCalledWith({ x: 120, y: 140 });
  });

  it('ignores late duplicate pointerdown when native stroke is already active', async () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));

    readPointBufferSinceMock
      .mockReturnValueOnce({
        points: [createNativePoint({ seq: 1, stroke_id: 1, phase: 'down', x_px: 180, y_px: 200 })],
        nextSeq: 1,
      })
      .mockReturnValue({
        points: [],
        nextSeq: 1,
      });

    await act(async () => {
      result.current.handlePointerDown(
        createReactPointerEvent(
          createNativePointerEvent({
            pointerId: 1,
            clientX: 100,
            clientY: 120,
            type: 'pointerdown',
          })
        )
      );
      await Promise.resolve();
    });

    params.isDrawingRef.current = true;
    params.strokeStateRef.current = 'active';
    vi.mocked(params.finishCurrentStroke).mockClear();
    readPointBufferSinceMock.mockClear();

    await act(async () => {
      result.current.handlePointerDown(
        createReactPointerEvent(
          createNativePointerEvent({
            pointerId: 1,
            clientX: 101,
            clientY: 121,
            type: 'pointerdown',
          })
        )
      );
      await Promise.resolve();
    });

    expect(params.finishCurrentStroke).not.toHaveBeenCalled();
    expect(readPointBufferSinceMock).not.toHaveBeenCalled();
  });

  it('forces restart for stale duplicate pointerdown beyond ignore window', async () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));

    readPointBufferSinceMock
      .mockReturnValueOnce({
        points: [createNativePoint({ seq: 1, stroke_id: 1, phase: 'down', x_px: 180, y_px: 200 })],
        nextSeq: 1,
      })
      .mockReturnValue({
        points: [],
        nextSeq: 1,
      });

    await act(async () => {
      result.current.handlePointerDown(
        createReactPointerEvent(
          createNativePointerEvent({
            pointerId: 1,
            clientX: 100,
            clientY: 120,
            type: 'pointerdown',
          })
        )
      );
      await Promise.resolve();
    });

    params.isDrawingRef.current = true;
    params.strokeStateRef.current = 'active';
    vi.mocked(params.finishCurrentStroke).mockClear();
    readPointBufferSinceMock.mockClear();

    const performanceNowSpy = vi.spyOn(performance, 'now').mockReturnValue(10_000);
    try {
      await act(async () => {
        result.current.handlePointerDown(
          createReactPointerEvent(
            createNativePointerEvent({
              pointerId: 1,
              clientX: 101,
              clientY: 121,
              type: 'pointerdown',
            })
          )
        );
        await Promise.resolve();
      });
    } finally {
      performanceNowSpy.mockRestore();
    }

    expect(params.finishCurrentStroke).toHaveBeenCalledTimes(1);
  });

  it('ignores stale duplicate pointerdown when session started without trusted down', async () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));

    readPointBufferSinceMock.mockReturnValue({
      points: [],
      nextSeq: 0,
      bufferEpoch: 0,
    });

    await act(async () => {
      result.current.handlePointerDown(
        createReactPointerEvent(
          createNativePointerEvent({
            pointerId: 1,
            clientX: 100,
            clientY: 120,
            type: 'pointerdown',
            isTrusted: false,
          })
        )
      );
      await Promise.resolve();
    });

    params.isDrawingRef.current = true;
    params.strokeStateRef.current = 'active';
    vi.mocked(params.finishCurrentStroke).mockClear();
    readPointBufferSinceMock.mockClear();

    const performanceNowSpy = vi.spyOn(performance, 'now').mockReturnValue(10_000);
    try {
      await act(async () => {
        result.current.handlePointerDown(
          createReactPointerEvent(
            createNativePointerEvent({
              pointerId: 1,
              clientX: 101,
              clientY: 121,
              type: 'pointerdown',
              isTrusted: true,
            })
          )
        );
        await Promise.resolve();
      });
    } finally {
      performanceNowSpy.mockRestore();
    }

    expect(params.finishCurrentStroke).not.toHaveBeenCalled();
    expect(readPointBufferSinceMock).not.toHaveBeenCalled();
  });

  it('resets stale pointer session when backend switches before next pointerdown', async () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));

    readPointBufferSinceMock.mockReturnValueOnce({
      points: [createNativePoint({ seq: 1, stroke_id: 1, phase: 'down', x_px: 180, y_px: 200 })],
      nextSeq: 1,
    });

    await act(async () => {
      result.current.handlePointerDown(
        createReactPointerEvent(
          createNativePointerEvent({
            pointerId: 1,
            clientX: 100,
            clientY: 120,
            type: 'pointerdown',
          })
        )
      );
      await Promise.resolve();
    });

    getTabletStateMock.mockReturnValue({
      isStreaming: true,
      backend: 'pointerevent',
      activeBackend: 'pointerevent',
      currentPoint: null,
    });

    await act(async () => {
      result.current.handlePointerDown(
        createReactPointerEvent(
          createNativePointerEvent({
            pointerId: 2,
            clientX: 130,
            clientY: 150,
            type: 'pointerdown',
          })
        )
      );
      await Promise.resolve();
    });

    expect((ctx.container as any).releasePointerCapture).toHaveBeenCalledWith(1);
    expect((ctx.container as any).setPointerCapture).toHaveBeenCalledWith(2);
    expect(params.captureBeforeImage).toHaveBeenCalledTimes(2);
  });

  it('waits previous stroke finish before starting new stroke', async () => {
    const ctx = createHookContext();
    const params = createHookParams(ctx, 'brush');
    const { result } = renderHook(() => usePointerHandlers(params as any));

    readPointBufferSinceMock.mockReturnValueOnce({
      points: [
        createNativePoint({ seq: 1, phase: 'down', x_px: 180, y_px: 200, pressure_0_1: 0.4 }),
      ],
      nextSeq: 1,
    });

    let resolveFinish: (() => void) | null = null;
    vi.mocked(params.finishCurrentStroke).mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveFinish = () => resolve(undefined);
        })
    );
    params.strokeStateRef.current = 'active';
    params.isDrawingRef.current = true;

    await act(async () => {
      result.current.handlePointerDown(
        createReactPointerEvent(
          createNativePointerEvent({
            pointerId: 1,
            clientX: 100,
            clientY: 120,
            type: 'pointerdown',
          })
        )
      );
      await Promise.resolve();
    });

    expect(params.finishCurrentStroke).toHaveBeenCalledTimes(1);
    expect(params.captureBeforeImage).not.toHaveBeenCalled();

    await act(async () => {
      resolveFinish?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(params.captureBeforeImage).toHaveBeenCalledTimes(1);
  });
});

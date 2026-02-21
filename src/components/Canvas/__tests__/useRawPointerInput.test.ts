import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const getTabletStateMock = vi.fn();

type UseRawPointerInputFn = (typeof import('../useRawPointerInput'))['useRawPointerInput'];

function createRawPointerEvent(
  init: Partial<PointerEvent> & { clientX?: number; clientY?: number; pressure?: number } = {}
): PointerEvent {
  return {
    clientX: init.clientX ?? 120,
    clientY: init.clientY ?? 130,
    pressure: init.pressure ?? 0.2,
    tiltX: init.tiltX ?? 0,
    tiltY: init.tiltY ?? 0,
    twist: init.twist ?? 0,
    isTrusted: init.isTrusted ?? true,
    type: init.type ?? 'pointerrawupdate',
    timeStamp: init.timeStamp ?? 2,
    getCoalescedEvents: init.getCoalescedEvents ?? (() => []),
  } as unknown as PointerEvent;
}

describe('useRawPointerInput backend gating', () => {
  let useRawPointerInput: UseRawPointerInputFn;

  beforeEach(async () => {
    vi.resetModules();
    getTabletStateMock.mockReset();
    Object.defineProperty(window, 'onpointerrawupdate', {
      configurable: true,
      value: null,
    });
    vi.doMock('@/stores/tablet', () => ({
      useTabletStore: {
        getState: () => getTabletStateMock(),
      },
    }));
    const mod = await import('../useRawPointerInput');
    useRawPointerInput = mod.useRawPointerInput;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@/stores/tablet');
  });

  it('disables raw pointer channel when native backend is active', () => {
    getTabletStateMock.mockReturnValue({
      isStreaming: true,
      backend: 'wintab',
      activeBackend: 'wintab',
      currentPoint: null,
    });

    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
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

    let rawListener: EventListener | null = null;
    vi.spyOn(container, 'addEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'pointerrawupdate' && typeof listener === 'function') {
          rawListener = listener;
        }
      }
    );
    vi.spyOn(container, 'removeEventListener').mockImplementation(() => {});

    const pendingPointsRef = { current: [] as Array<Record<string, unknown>> };
    const inputQueueRef = { current: [] as Array<Record<string, unknown>> };

    const { result } = renderHook(() =>
      useRawPointerInput({
        containerRef: { current: container },
        canvasRef: { current: canvas },
        isDrawingRef: { current: true },
        currentTool: 'brush',
        strokeStateRef: { current: 'active' },
        pendingPointsRef: pendingPointsRef as never,
        inputQueueRef: inputQueueRef as never,
        pointIndexRef: { current: 0 },
        latencyProfiler: { markInputReceived: vi.fn() },
        onPointBuffered: vi.fn(),
      })
    );

    expect(rawListener).toBeTypeOf('function');
    act(() => {
      rawListener?.(createRawPointerEvent() as unknown as Event);
    });

    expect(result.current.usingRawInput.current).toBe(false);
    expect(pendingPointsRef.current).toHaveLength(0);
    expect(inputQueueRef.current).toHaveLength(0);
  });

  it('enables raw pointer channel in pointerevent mode and queues points', () => {
    getTabletStateMock.mockReturnValue({
      isStreaming: true,
      backend: 'pointerevent',
      activeBackend: 'pointerevent',
      currentPoint: null,
    });

    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
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

    let rawListener: EventListener | null = null;
    vi.spyOn(container, 'addEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'pointerrawupdate' && typeof listener === 'function') {
          rawListener = listener;
        }
      }
    );
    vi.spyOn(container, 'removeEventListener').mockImplementation(() => {});

    const pendingPointsRef = { current: [] as Array<Record<string, unknown>> };
    const inputQueueRef = { current: [] as Array<Record<string, unknown>> };

    const { result } = renderHook(() =>
      useRawPointerInput({
        containerRef: { current: container },
        canvasRef: { current: canvas },
        isDrawingRef: { current: true },
        currentTool: 'brush',
        strokeStateRef: { current: 'active' },
        pendingPointsRef: pendingPointsRef as never,
        inputQueueRef: inputQueueRef as never,
        pointIndexRef: { current: 0 },
        latencyProfiler: { markInputReceived: vi.fn() },
        onPointBuffered: vi.fn(),
      })
    );

    expect(rawListener).toBeTypeOf('function');
    act(() => {
      rawListener?.(
        createRawPointerEvent({ clientX: 200, clientY: 220, pressure: 0.4 }) as unknown as Event
      );
    });

    expect(result.current.usingRawInput.current).toBe(true);
    expect(inputQueueRef.current).toHaveLength(1);
    const point = inputQueueRef.current[0] as {
      x: number;
      y: number;
      pressure: number;
      source: string;
    };
    expect(point.x).toBeCloseTo(200, 6);
    expect(point.y).toBeCloseTo(220, 6);
    expect(point.pressure).toBeCloseTo(0.4, 6);
    expect(point.source).toBe('pointerevent');
  });

  it('forwards raw coalesced events to unified ingress handler when provided', () => {
    getTabletStateMock.mockReturnValue({
      isStreaming: true,
      backend: 'pointerevent',
      activeBackend: 'pointerevent',
      currentPoint: null,
    });

    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
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

    let rawListener: EventListener | null = null;
    vi.spyOn(container, 'addEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'pointerrawupdate' && typeof listener === 'function') {
          rawListener = listener;
        }
      }
    );
    vi.spyOn(container, 'removeEventListener').mockImplementation(() => {});

    const pendingPointsRef = { current: [] as Array<Record<string, unknown>> };
    const inputQueueRef = { current: [] as Array<Record<string, unknown>> };
    const ingressHandler = vi.fn();

    const eventA = createRawPointerEvent({ clientX: 210, clientY: 230, pressure: 0.31 });
    const eventB = createRawPointerEvent({ clientX: 212, clientY: 232, pressure: 0.33 });
    const mainEvent = createRawPointerEvent({
      getCoalescedEvents: () => [eventA, eventB],
    });

    const { result } = renderHook(() =>
      useRawPointerInput({
        containerRef: { current: container },
        canvasRef: { current: canvas },
        isDrawingRef: { current: true },
        currentTool: 'brush',
        pointerIngressHandlerRef: { current: ingressHandler },
        strokeStateRef: { current: 'active' },
        pendingPointsRef: pendingPointsRef as never,
        inputQueueRef: inputQueueRef as never,
        pointIndexRef: { current: 0 },
        latencyProfiler: { markInputReceived: vi.fn() },
        onPointBuffered: vi.fn(),
      })
    );

    expect(rawListener).toBeTypeOf('function');
    act(() => {
      rawListener?.(mainEvent as unknown as Event);
    });

    expect(result.current.usingRawInput.current).toBe(true);
    expect(ingressHandler).toHaveBeenCalledTimes(1);
    const firstCallArgs = ingressHandler.mock.calls[0]?.[0] as PointerEvent[];
    expect(firstCallArgs).toHaveLength(2);
    expect(firstCallArgs[0]?.clientX).toBe(210);
    expect(firstCallArgs[1]?.clientX).toBe(212);
    expect(pendingPointsRef.current).toHaveLength(0);
    expect(inputQueueRef.current).toHaveLength(0);
  });
});

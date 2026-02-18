import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const readPointBufferSinceMock = vi.fn();
const getTabletStateMock = vi.fn();

type UseRawPointerInputFn = (typeof import('../useRawPointerInput'))['useRawPointerInput'];

function createNativePoint(partial: Partial<Record<string, unknown>> = {}) {
  return {
    seq: partial.seq ?? 1,
    stream_id: partial.stream_id ?? 1,
    source: partial.source ?? 'wintab',
    pointer_id: partial.pointer_id ?? 1,
    phase: partial.phase ?? 'move',
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    pressure: partial.pressure ?? 0.5,
    tilt_x: partial.tilt_x ?? 0,
    tilt_y: partial.tilt_y ?? 0,
    rotation: partial.rotation ?? 0,
    host_time_us: partial.host_time_us ?? 1000,
    device_time_us: partial.device_time_us ?? 1000,
    timestamp_ms: partial.timestamp_ms ?? 1,
  };
}

function createRawPointerEvent(
  init: Partial<PointerEvent> & {
    clientX?: number;
    clientY?: number;
    pressure?: number;
    isTrusted?: boolean;
    type?: string;
  } = {}
): PointerEvent {
  return {
    clientX: init.clientX ?? 120,
    clientY: init.clientY ?? 130,
    pressure: init.pressure ?? 0.1,
    tiltX: init.tiltX ?? 0,
    tiltY: init.tiltY ?? 0,
    twist: init.twist ?? 0,
    isTrusted: init.isTrusted ?? true,
    type: init.type ?? 'pointerrawupdate',
    timeStamp: init.timeStamp ?? 1,
    getCoalescedEvents: init.getCoalescedEvents ?? (() => []),
  } as unknown as PointerEvent;
}

describe('useRawPointerInput pointer geometry fallback', () => {
  let useRawPointerInput: UseRawPointerInputFn;

  beforeEach(async () => {
    vi.resetModules();
    readPointBufferSinceMock.mockReset();
    getTabletStateMock.mockReset();
    Object.defineProperty(window, 'onpointerrawupdate', {
      configurable: true,
      value: null,
    });
    vi.doMock('@/stores/tablet', () => ({
      readPointBufferSince: (...args: unknown[]) => readPointBufferSinceMock(...args),
      useTabletStore: {
        getState: () => getTabletStateMock(),
      },
    }));
    const mod = await import('../useRawPointerInput');
    useRawPointerInput = mod.useRawPointerInput;
    getTabletStateMock.mockReturnValue({
      isStreaming: true,
      backend: 'wintab',
      activeBackend: 'wintab',
      currentPoint: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@/stores/tablet');
  });

  it('uses pointer geometry while keeping native pressure/source in raw path', () => {
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

    readPointBufferSinceMock.mockReturnValue({
      points: [createNativePoint({ seq: 1, x: 600, y: 40, pressure: 0.6, source: 'wintab' })],
      nextSeq: 1,
    });

    const pendingPointsRef = { current: [] as Array<Record<string, unknown>> };
    const inputQueueRef = { current: [] as Array<Record<string, unknown>> };

    renderHook(() =>
      useRawPointerInput({
        containerRef: { current: container },
        canvasRef: { current: canvas },
        isDrawingRef: { current: true },
        currentTool: 'brush',
        strokeStateRef: { current: 'starting' },
        pendingPointsRef: pendingPointsRef as never,
        inputQueueRef: inputQueueRef as never,
        pointIndexRef: { current: 0 },
        latencyProfiler: { markInputReceived: vi.fn() },
        onPointBuffered: vi.fn(),
      })
    );

    expect(rawListener).toBeTypeOf('function');
    act(() => {
      rawListener?.(createRawPointerEvent({ clientX: 120, clientY: 130 }) as unknown as Event);
    });

    const tail = pendingPointsRef.current[pendingPointsRef.current.length - 1] as
      | { x: number; y: number; pressure: number; source: string }
      | undefined;
    expect(tail).toBeDefined();
    expect(tail?.x).toBeCloseTo(120, 6);
    expect(tail?.y).toBeCloseTo(130, 6);
    expect(tail?.pressure).toBeCloseTo(0.6, 6);
    expect(tail?.source).toBe('wintab');
  });

  it('keeps pointer geometry on macnative when native y looks mirrored', () => {
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

    getTabletStateMock.mockReturnValue({
      isStreaming: true,
      backend: 'macnative',
      activeBackend: 'macnative',
      currentPoint: null,
    });
    readPointBufferSinceMock.mockReturnValue({
      points: [createNativePoint({ seq: 1, x: 90, y: 460, pressure: 0.35, source: 'macnative' })],
      nextSeq: 1,
    });

    const pendingPointsRef = { current: [] as Array<Record<string, unknown>> };
    const inputQueueRef = { current: [] as Array<Record<string, unknown>> };

    renderHook(() =>
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
      rawListener?.(createRawPointerEvent({ clientX: 140, clientY: 160 }) as unknown as Event);
    });

    const last = inputQueueRef.current[inputQueueRef.current.length - 1] as
      | { x: number; y: number; source: string; pressure: number }
      | undefined;
    expect(last).toBeDefined();
    expect(last?.x).toBeCloseTo(140, 6);
    expect(last?.y).toBeCloseTo(160, 6);
    expect(last?.source).toBe('macnative');
    expect(last?.pressure).toBeCloseTo(0.35, 6);
  });
});

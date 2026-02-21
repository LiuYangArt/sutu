import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCursor, __resetHardwareCursorCacheForTest } from '../useCursor';

type UseCursorProps = Parameters<typeof useCursor>[0];

function createProps(overrides: Partial<UseCursorProps> = {}): UseCursorProps {
  return {
    currentTool: 'brush',
    currentSize: 24,
    scale: 1,
    showCrosshair: false,
    spacePressed: false,
    isPanning: false,
    containerRef: { current: null } as React.RefObject<HTMLDivElement>,
    brushCursorRef: { current: null } as React.RefObject<HTMLDivElement>,
    eyedropperCursorRef: { current: null } as React.RefObject<HTMLDivElement>,
    brushRoundness: 100,
    brushAngle: 0,
    brushTexture: null,
    canvasRef: { current: null } as React.RefObject<HTMLCanvasElement>,
    ...overrides,
  };
}

const SIMPLE_CURSOR_PATH = 'M0 0 L1 0 L1 1 L0 1 Z';
const LOD0_CURSOR_PATH = 'M0 0 L1 0 L1 0.8 L0 1 Z';
const LOD1_CURSOR_PATH = 'M0 0 L1 0 L1 1 L0.2 1 Z';
const LOD2_CURSOR_PATH = 'M0 0 L1 0 L0.8 1 L0 1 Z';
const OVER_LIMIT_CURSOR_PATH = `${SIMPLE_CURSOR_PATH} `.repeat(12001);

function getLastBtoaInput(spy: { mock: { calls: unknown[][] } }): string {
  const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
  return typeof lastCall?.[0] === 'string' ? lastCall[0] : '';
}

describe('useCursor', () => {
  beforeEach(() => {
    __resetHardwareCursorCacheForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('<=24 硬件模式优先选择 LOD2', () => {
    const btoaSpy = vi.spyOn(globalThis, 'btoa');
    const props = createProps({
      currentSize: 24,
      brushTexture: {
        cursorId: 'tip-hardware-lod2',
        cursorPath: SIMPLE_CURSOR_PATH,
        cursorPathLod0: LOD0_CURSOR_PATH,
        cursorPathLod1: LOD1_CURSOR_PATH,
        cursorPathLod2: LOD2_CURSOR_PATH,
      },
    });

    const { result } = renderHook(() => useCursor(props));

    expect(result.current.showDomCursor).toBe(false);
    expect(result.current.cursorStyle.startsWith('url("data:image/svg+xml;base64,')).toBe(true);
    expect(getLastBtoaInput(btoaSpy)).toContain(LOD2_CURSOR_PATH);
  });

  it('24~96 硬件模式优先选择 LOD1', () => {
    const btoaSpy = vi.spyOn(globalThis, 'btoa');
    const props = createProps({
      currentSize: 48,
      brushTexture: {
        cursorId: 'tip-hardware-lod1',
        cursorPath: SIMPLE_CURSOR_PATH,
        cursorPathLod0: LOD0_CURSOR_PATH,
        cursorPathLod1: LOD1_CURSOR_PATH,
        cursorPathLod2: LOD2_CURSOR_PATH,
      },
    });

    const { result } = renderHook(() => useCursor(props));

    expect(result.current.showDomCursor).toBe(false);
    expect(result.current.cursorStyle.startsWith('url("data:image/svg+xml;base64,')).toBe(true);
    expect(getLastBtoaInput(btoaSpy)).toContain(LOD1_CURSOR_PATH);
  });

  it('small brush with over-limit cursorPath falls back to DOM cursor', () => {
    const props = createProps({
      currentSize: 24,
      brushTexture: {
        cursorId: 'tip-over-limit',
        cursorPath: OVER_LIMIT_CURSOR_PATH,
      },
    });

    const { result } = renderHook(() => useCursor(props));

    expect(result.current.showDomCursor).toBe(true);
    expect(result.current.cursorStyle).toBe('none');
  });

  it('falls back to DOM cursor when hardware complexity budget is exceeded', () => {
    const props = createProps({
      currentSize: 24,
      brushTexture: {
        cursorId: 'tip-complexity-over-budget',
        cursorPath: SIMPLE_CURSOR_PATH,
        cursorPathLod2: LOD2_CURSOR_PATH,
        cursorComplexityLod2: {
          pathLen: LOD2_CURSOR_PATH.length,
          segmentCount: 9001,
          contourCount: 1,
        },
      },
    });

    const { result } = renderHook(() => useCursor(props));

    expect(result.current.showDomCursor).toBe(true);
    expect(result.current.cursorStyle).toBe('none');
  });

  it('DOM 模式默认选择 LOD0', () => {
    const props = createProps({
      currentSize: 180,
      brushTexture: {
        cursorId: 'tip-large',
        cursorPath: SIMPLE_CURSOR_PATH,
        cursorPathLod0: LOD0_CURSOR_PATH,
        cursorPathLod1: LOD1_CURSOR_PATH,
        cursorPathLod2: LOD2_CURSOR_PATH,
      },
    });

    const { result } = renderHook(() => useCursor(props));

    expect(result.current.showDomCursor).toBe(true);
    expect(result.current.cursorStyle).toBe('none');
    expect(result.current.resolvedDomCursorPath).toBe(LOD0_CURSOR_PATH);
  });

  it('缺失 LOD 字段时回退 legacy cursorPath', () => {
    const props = createProps({
      currentSize: 180,
      brushTexture: {
        cursorId: 'tip-legacy-only',
        cursorPath: SIMPLE_CURSOR_PATH,
      },
    });

    const { result } = renderHook(() => useCursor(props));
    expect(result.current.showDomCursor).toBe(true);
    expect(result.current.resolvedDomCursorPath).toBe(SIMPLE_CURSOR_PATH);
  });

  it('forceDomCursor debug switch disables hardware cursor even for small brush', () => {
    const btoaSpy = vi.spyOn(globalThis, 'btoa');
    const props = createProps({
      currentSize: 24,
      forceDomCursor: true,
      brushTexture: {
        cursorId: 'tip-force-dom',
        cursorPath: SIMPLE_CURSOR_PATH,
      },
    });

    const { result } = renderHook(() => useCursor(props));
    expect(result.current.showDomCursor).toBe(true);
    expect(result.current.cursorStyle).toBe('none');
    expect(btoaSpy).not.toHaveBeenCalled();
  });

  it('reuses cached hardware cursor URL for identical key', () => {
    const btoaSpy = vi.spyOn(globalThis, 'btoa');
    const props = createProps({
      brushTexture: {
        cursorId: 'cache-tip-hit',
        cursorPath: SIMPLE_CURSOR_PATH,
      },
      brushAngle: 5,
    });

    const first = renderHook(() => useCursor(props));
    first.unmount();
    expect(btoaSpy).toHaveBeenCalledTimes(1);

    const second = renderHook(() => useCursor(props));
    second.unmount();
    expect(btoaSpy).toHaveBeenCalledTimes(1);
  });

  it('rebuilds hardware cursor URL when cache key changes', () => {
    const btoaSpy = vi.spyOn(globalThis, 'btoa');
    const firstProps = createProps({
      currentSize: 24,
      brushTexture: {
        cursorId: 'cache-tip-key-change',
        cursorPath: SIMPLE_CURSOR_PATH,
      },
      brushAngle: 10,
    });
    const secondProps = createProps({
      currentSize: 25,
      brushTexture: {
        cursorId: 'cache-tip-key-change',
        cursorPath: SIMPLE_CURSOR_PATH,
      },
      brushAngle: 10,
    });

    const first = renderHook(() => useCursor(firstProps));
    first.unmount();
    expect(btoaSpy).toHaveBeenCalledTimes(1);

    const second = renderHook(() => useCursor(secondProps));
    second.unmount();
    expect(btoaSpy).toHaveBeenCalledTimes(2);
  });

  it('evicts oldest cache entry when capacity is exceeded', () => {
    const btoaSpy = vi.spyOn(globalThis, 'btoa');

    for (let angle = 0; angle <= 64; angle += 1) {
      const props = createProps({
        brushAngle: angle,
        brushTexture: {
          cursorId: 'cache-tip-eviction',
          cursorPath: SIMPLE_CURSOR_PATH,
        },
      });
      const hook = renderHook(() => useCursor(props));
      hook.unmount();
    }

    const callsAfterFill = btoaSpy.mock.calls.length;

    const evictedKeyProps = createProps({
      brushAngle: 0,
      brushTexture: {
        cursorId: 'cache-tip-eviction',
        cursorPath: SIMPLE_CURSOR_PATH,
      },
    });
    const remount = renderHook(() => useCursor(evictedKeyProps));
    remount.unmount();

    expect(btoaSpy.mock.calls.length).toBe(callsAfterFill + 1);
  });
});

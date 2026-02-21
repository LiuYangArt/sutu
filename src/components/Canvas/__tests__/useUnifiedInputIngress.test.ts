import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readPointBufferSinceMock = vi.fn();

vi.mock('@/stores/tablet', () => ({
  readPointBufferSince: (...args: unknown[]) => readPointBufferSinceMock(...args),
}));

import {
  useUnifiedInputIngress,
  createIngressGateStateV3,
  type UnifiedIngressPointV3,
} from '../useUnifiedInputIngress';

function makePoint(overrides: Partial<UnifiedIngressPointV3>): UnifiedIngressPointV3 {
  return {
    seq: overrides.seq ?? 1,
    stroke_id: overrides.stroke_id ?? 1,
    pointer_id: overrides.pointer_id ?? 7,
    source: overrides.source ?? 'macnative',
    phase: overrides.phase ?? 'move',
    x_px: overrides.x_px ?? 10,
    y_px: overrides.y_px ?? 20,
    pressure_0_1: overrides.pressure_0_1 ?? 0.5,
    tilt_x_deg: overrides.tilt_x_deg ?? 0,
    tilt_y_deg: overrides.tilt_y_deg ?? 0,
    rotation_deg: overrides.rotation_deg ?? 0,
    host_time_us: overrides.host_time_us ?? 1000,
    device_time_us: overrides.device_time_us ?? 900,
  };
}

describe('useUnifiedInputIngress', () => {
  beforeEach(() => {
    readPointBufferSinceMock.mockReset();
  });

  it('consumes native points through unified router', () => {
    readPointBufferSinceMock.mockReturnValue({
      points: [
        {
          ...makePoint({ seq: 1, phase: 'down' }),
          device_id: 'd1',
          x: 10,
          y: 20,
          pressure: 0.5,
          tilt_x: 0,
          tilt_y: 0,
          rotation: 0,
          timestamp_ms: 1,
        },
      ],
      nextSeq: 1,
      bufferEpoch: 0,
    });

    const { result } = renderHook(() =>
      useUnifiedInputIngress({
        getGateState: () => createIngressGateStateV3(),
      })
    );

    const batch = result.current.consumeNativeRoutedPoints('test.native');

    expect(batch?.events).toHaveLength(1);
    expect(batch?.events[0]?.phase).toBe('down');
    expect(batch?.cursor.seq).toBe(1);
  });

  it('drops native points when gesture gate is active', () => {
    readPointBufferSinceMock.mockReturnValue({
      points: [
        {
          ...makePoint({ seq: 2, phase: 'move' }),
          device_id: 'd1',
          x: 10,
          y: 20,
          pressure: 0.5,
          tilt_x: 0,
          tilt_y: 0,
          rotation: 0,
          timestamp_ms: 1,
        },
      ],
      nextSeq: 2,
      bufferEpoch: 0,
    });

    const { result } = renderHook(() =>
      useUnifiedInputIngress({
        getGateState: () =>
          createIngressGateStateV3({
            spacePressed: true,
            isPanning: true,
          }),
      })
    );

    const batch = result.current.consumeNativeRoutedPoints('test.gesture_block');

    expect(batch?.events).toHaveLength(0);
    expect(batch?.diagnosticsDelta.gesture_block_drop_count).toBe(1);
  });

  it('routes pointer ingress points with synthetic seq', () => {
    const { result } = renderHook(() =>
      useUnifiedInputIngress({
        getGateState: () => createIngressGateStateV3(),
      })
    );

    const batch = result.current.routePointerIngressPoints('test.pointer', [
      makePoint({ seq: 0, stroke_id: 11, phase: 'down', source: 'pointerevent' }),
      makePoint({ seq: 0, stroke_id: 11, phase: 'move', source: 'pointerevent' }),
    ]);

    expect(batch?.events).toHaveLength(2);
    expect(batch?.events[0]?.seq).toBeGreaterThan(0);
    expect(batch?.events[1]?.seq).toBeGreaterThan(batch?.events[0]?.seq ?? 0);
  });
});

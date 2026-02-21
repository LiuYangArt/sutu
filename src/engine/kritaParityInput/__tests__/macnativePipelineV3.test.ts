import { describe, expect, it } from 'vitest';
import type { TabletInputPoint } from '@/stores/tablet';
import {
  MacnativeSessionRouterV3,
  createMacnativeSessionCursorV3,
} from '../macnativeSessionRouterV3';

function makePoint(partial: Partial<TabletInputPoint>): TabletInputPoint {
  return {
    seq: partial.seq ?? 1,
    stroke_id: partial.stroke_id ?? 1,
    pointer_id: partial.pointer_id ?? 1,
    device_id: partial.device_id ?? 'macnative-device',
    source: partial.source ?? 'macnative',
    phase: partial.phase ?? 'move',
    x_px: partial.x_px ?? 100,
    y_px: partial.y_px ?? 120,
    pressure_0_1: partial.pressure_0_1 ?? 0.5,
    tilt_x_deg: partial.tilt_x_deg ?? 0,
    tilt_y_deg: partial.tilt_y_deg ?? 0,
    rotation_deg: partial.rotation_deg ?? 0,
    host_time_us: partial.host_time_us ?? 10_000,
    device_time_us: partial.device_time_us ?? 9_900,
    x: partial.x ?? partial.x_px ?? 100,
    y: partial.y ?? partial.y_px ?? 120,
    pressure: partial.pressure ?? partial.pressure_0_1 ?? 0.5,
    tilt_x: partial.tilt_x ?? partial.tilt_x_deg ?? 0,
    tilt_y: partial.tilt_y ?? partial.tilt_y_deg ?? 0,
    rotation: partial.rotation ?? partial.rotation_deg ?? 0,
    timestamp_ms: partial.timestamp_ms ?? 10,
  };
}

describe('MacnativeSessionRouterV3 pipeline', () => {
  it('requires explicit down for a stroke and keeps explicit up tail', () => {
    const router = new MacnativeSessionRouterV3();
    let cursor = createMacnativeSessionCursorV3();

    const missingDown = router.route({
      points: [makePoint({ seq: 1, stroke_id: 42, phase: 'move' })],
      cursor,
      bufferEpoch: 0,
    });
    expect(missingDown.events).toHaveLength(0);
    expect(missingDown.diagnosticsDelta.native_down_without_seed_count).toBe(1);

    cursor = missingDown.nextCursor;
    const routed = router.route({
      points: [
        makePoint({ seq: 2, stroke_id: 42, phase: 'down', pressure_0_1: 0.2 }),
        makePoint({ seq: 3, stroke_id: 42, phase: 'move', pressure_0_1: 0.3 }),
        makePoint({ seq: 4, stroke_id: 42, phase: 'up', pressure_0_1: 0 }),
      ],
      cursor,
      bufferEpoch: 0,
    });

    expect(routed.events.map((event) => event.phase)).toEqual(['down', 'move', 'up']);
    expect(routed.events[0]?.stroke_id).toBe(42);
    expect(routed.events[2]?.phase).toBe('up');
    expect(routed.nextCursor.activeStrokeId).toBeNull();
  });

  it('rejects mixed source within same stroke_id', () => {
    const router = new MacnativeSessionRouterV3();
    let cursor = createMacnativeSessionCursorV3();

    const down = router.route({
      points: [makePoint({ seq: 1, stroke_id: 9, source: 'macnative', phase: 'down' })],
      cursor,
      bufferEpoch: 0,
    });
    cursor = down.nextCursor;
    expect(down.events).toHaveLength(1);

    const mixedMove = router.route({
      points: [makePoint({ seq: 2, stroke_id: 9, source: 'pointerevent', phase: 'move' })],
      cursor,
      bufferEpoch: 0,
    });
    expect(mixedMove.events).toHaveLength(0);
    expect(mixedMove.diagnosticsDelta.mixed_source_reject_count).toBe(1);
  });
});

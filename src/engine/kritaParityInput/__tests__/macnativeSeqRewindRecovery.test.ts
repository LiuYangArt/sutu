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

describe('MacnativeSessionRouterV3 seq rewind recovery', () => {
  it('resets cursor when bufferEpoch changes and recovers on next down', () => {
    const router = new MacnativeSessionRouterV3();
    let cursor = createMacnativeSessionCursorV3();

    const firstPass = router.route({
      points: [
        makePoint({ seq: 90, stroke_id: 1, phase: 'down' }),
        makePoint({ seq: 91, stroke_id: 1, phase: 'move' }),
      ],
      cursor,
      bufferEpoch: 0,
    });
    expect(firstPass.events).toHaveLength(2);
    expect(firstPass.nextCursor.seq).toBe(91);

    cursor = firstPass.nextCursor;
    const rewindFail = router.route({
      points: [makePoint({ seq: 2, stroke_id: 2, phase: 'move' })],
      cursor,
      bufferEpoch: 1,
    });
    expect(rewindFail.events).toHaveLength(0);
    expect(rewindFail.diagnosticsDelta.seq_rewind_recovery_fail_count).toBe(1);

    cursor = rewindFail.nextCursor;
    const recovered = router.route({
      points: [
        makePoint({ seq: 3, stroke_id: 2, phase: 'down' }),
        makePoint({ seq: 4, stroke_id: 2, phase: 'move' }),
      ],
      cursor,
      bufferEpoch: 1,
    });
    expect(recovered.events.map((event) => event.phase)).toEqual(['down', 'move']);
    expect(recovered.nextCursor.activeStrokeId).toBe(2);
  });
});

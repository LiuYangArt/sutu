import { describe, expect, it } from 'vitest';
import {
  UnifiedSessionRouterV3,
  createIngressCursorV3,
  createIngressGateStateV3,
  type UnifiedIngressPointV3,
} from '../unifiedSessionRouterV3';

function makePoint(overrides: Partial<UnifiedIngressPointV3>): UnifiedIngressPointV3 {
  return {
    seq: overrides.seq ?? 1,
    stroke_id: overrides.stroke_id ?? 1,
    pointer_id: overrides.pointer_id ?? 7,
    source: overrides.source ?? 'macnative',
    phase: overrides.phase ?? 'move',
    x_px: overrides.x_px ?? 100,
    y_px: overrides.y_px ?? 120,
    pressure_0_1: overrides.pressure_0_1 ?? 0.5,
    tilt_x_deg: overrides.tilt_x_deg ?? 0,
    tilt_y_deg: overrides.tilt_y_deg ?? 0,
    rotation_deg: overrides.rotation_deg ?? 0,
    host_time_us: overrides.host_time_us ?? 10_000,
    device_time_us: overrides.device_time_us ?? 9_900,
  };
}

describe('UnifiedSessionRouterV3', () => {
  it('accepts down/move/up in same stroke and keeps cursor state', () => {
    const router = new UnifiedSessionRouterV3();
    const cursor = createIngressCursorV3();

    const result = router.route({
      points: [
        makePoint({ seq: 1, stroke_id: 3, phase: 'down' }),
        makePoint({ seq: 2, stroke_id: 3, phase: 'move' }),
        makePoint({ seq: 3, stroke_id: 3, phase: 'up' }),
      ],
      cursor,
      bufferEpoch: 0,
      gateState: createIngressGateStateV3(),
    });

    expect(result.acceptedEvents.map((event) => event.phase)).toEqual(['down', 'move', 'up']);
    expect(result.nextCursor.seq).toBe(3);
    expect(result.nextCursor.activeStrokeId).toBeNull();
  });

  it('drops events when gesture gate is active', () => {
    const router = new UnifiedSessionRouterV3();
    const cursor = createIngressCursorV3();

    const result = router.route({
      points: [
        makePoint({ seq: 1, stroke_id: 4, phase: 'down' }),
        makePoint({ seq: 2, stroke_id: 4, phase: 'move' }),
      ],
      cursor,
      bufferEpoch: 0,
      gateState: createIngressGateStateV3({ spacePressed: true, isPanning: true }),
    });

    expect(result.acceptedEvents).toHaveLength(0);
    expect(result.diagnosticsDelta.gesture_block_drop_count).toBe(2);
    expect(result.nextCursor.seq).toBe(2);
  });

  it('rejects mixed source for the same stroke_id', () => {
    const router = new UnifiedSessionRouterV3();
    let cursor = createIngressCursorV3();

    const first = router.route({
      points: [makePoint({ seq: 1, stroke_id: 8, phase: 'down', source: 'macnative' })],
      cursor,
      bufferEpoch: 0,
      gateState: createIngressGateStateV3(),
    });

    cursor = first.nextCursor;
    const mixed = router.route({
      points: [makePoint({ seq: 2, stroke_id: 8, phase: 'move', source: 'pointerevent' })],
      cursor,
      bufferEpoch: 0,
      gateState: createIngressGateStateV3(),
    });

    expect(mixed.acceptedEvents).toHaveLength(0);
    expect(mixed.diagnosticsDelta.mixed_source_reject_count).toBe(1);
  });
});

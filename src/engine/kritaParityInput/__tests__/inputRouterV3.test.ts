import { describe, expect, it } from 'vitest';
import { InputRouterV3 } from '../inputRouterV3';
import type { NativeTabletEventV3 } from '../contracts';

function makeEvent(partial: Partial<NativeTabletEventV3>): NativeTabletEventV3 {
  return {
    seq: partial.seq ?? 1,
    stroke_id: partial.stroke_id ?? 1,
    pointer_id: partial.pointer_id ?? 1,
    device_id: partial.device_id ?? 'tablet',
    source: partial.source ?? 'wintab',
    phase: partial.phase ?? 'move',
    x_px: partial.x_px ?? 10,
    y_px: partial.y_px ?? 20,
    pressure_0_1: partial.pressure_0_1 ?? 0.5,
    tilt_x_deg: partial.tilt_x_deg ?? 0,
    tilt_y_deg: partial.tilt_y_deg ?? 0,
    rotation_deg: partial.rotation_deg ?? 0,
    host_time_us: partial.host_time_us ?? 1_000,
    device_time_us: partial.device_time_us,
  };
}

describe('InputRouterV3', () => {
  it('accepts single-source events within one stroke', () => {
    const router = new InputRouterV3();
    const down = makeEvent({ stroke_id: 42, source: 'wintab', phase: 'down' });
    const move = makeEvent({ seq: 2, stroke_id: 42, source: 'wintab', phase: 'move' });
    expect(router.route(down)).toEqual(down);
    expect(router.route(move)).toEqual(move);
  });

  it('rejects mixed-source events for same stroke_id', () => {
    const router = new InputRouterV3();
    const down = makeEvent({ stroke_id: 7, source: 'wintab', phase: 'down' });
    const mixedMove = makeEvent({
      seq: 2,
      stroke_id: 7,
      source: 'pointerevent',
      phase: 'move',
    });
    expect(router.route(down)).toEqual(down);
    expect(router.route(mixedMove)).toBeNull();
  });

  it('releases lock on up so next stroke can switch source', () => {
    const router = new InputRouterV3();
    const up = makeEvent({ stroke_id: 11, source: 'wintab', phase: 'up' });
    const nextDown = makeEvent({
      seq: 2,
      stroke_id: 11,
      source: 'pointerevent',
      phase: 'down',
    });
    expect(router.route(up)).toEqual(up);
    expect(router.route(nextDown)).toEqual(nextDown);
  });
});

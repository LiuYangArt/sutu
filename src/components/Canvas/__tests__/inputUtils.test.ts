import { beforeEach, describe, expect, it } from 'vitest';
import type { TabletInputPoint } from '@/stores/tablet';
import {
  getNativeCoordinateDiagnosticsSnapshot,
  isNativeTabletStreamingBackend,
  isNativeTabletStreamingState,
  mapNativeWindowPxToCanvasPoint,
  parseNativeTabletSample,
  parsePointerEventSample,
  resetNativeCoordinateDiagnosticsForTest,
  resolveNativeStrokePoints,
} from '../inputUtils';

function createNativePoint(partial: Partial<TabletInputPoint> = {}): TabletInputPoint {
  return {
    seq: partial.seq ?? 1,
    stroke_id: partial.stroke_id ?? 9,
    pointer_id: partial.pointer_id ?? 7,
    device_id: partial.device_id ?? 'tablet-1',
    source: partial.source ?? 'wintab',
    phase: partial.phase ?? 'move',
    x_px: partial.x_px ?? 100,
    y_px: partial.y_px ?? 80,
    pressure_0_1: partial.pressure_0_1 ?? 0.5,
    tilt_x_deg: partial.tilt_x_deg ?? 10,
    tilt_y_deg: partial.tilt_y_deg ?? -20,
    rotation_deg: partial.rotation_deg ?? 135,
    host_time_us: partial.host_time_us ?? 20_000,
    device_time_us: partial.device_time_us ?? 19_500,
    x: partial.x ?? 100,
    y: partial.y ?? 80,
    pressure: partial.pressure ?? 0.5,
    tilt_x: partial.tilt_x ?? 10,
    tilt_y: partial.tilt_y ?? -20,
    rotation: partial.rotation ?? 135,
    timestamp_ms: partial.timestamp_ms ?? 20,
  };
}

function createPointerEvent(
  init: Partial<PointerEvent> & {
    type?: string;
    pressure?: number;
    tiltX?: number;
    tiltY?: number;
    twist?: number;
  } = {}
): PointerEvent {
  return {
    type: init.type ?? 'pointermove',
    pressure: init.pressure ?? 0.4,
    tiltX: init.tiltX ?? 45,
    tiltY: init.tiltY ?? -30,
    twist: init.twist ?? 270,
    timeStamp: init.timeStamp ?? 12,
    pointerType: init.pointerType ?? 'pen',
  } as unknown as PointerEvent;
}

describe('inputUtils', () => {
  beforeEach(() => {
    resetNativeCoordinateDiagnosticsForTest();
  });

  it('parsePointerEventSample returns normalized pointerevent sample', () => {
    const sample = parsePointerEventSample(createPointerEvent());
    expect(sample).toMatchObject({
      pressure: 0.4,
      tiltX: 0.5,
      tiltY: -1 / 3,
      rotation: 270,
      source: 'pointerevent',
      phase: 'move',
      timestampMs: 12,
      hostTimeUs: 12_000,
      deviceTimeUs: 0,
    });
  });

  it('parsePointerEventSample forces zero pressure on pointerup', () => {
    const sample = parsePointerEventSample(
      createPointerEvent({ type: 'pointerup', pressure: 0.9 })
    );
    expect(sample.phase).toBe('up');
    expect(sample.pressure).toBe(0);
  });

  it('parseNativeTabletSample keeps native geometry and normalizes values', () => {
    const sample = parseNativeTabletSample(
      createNativePoint({
        x_px: 320,
        y_px: 240,
        pressure_0_1: 0.8,
        tilt_x_deg: 18,
        tilt_y_deg: -9,
        rotation_deg: 725,
      })
    );
    expect(sample).toMatchObject({
      xPx: 320,
      yPx: 240,
      pressure: 0.8,
      tiltX: 0.2,
      tiltY: -0.1,
      rotation: 5,
      source: 'wintab',
      phase: 'move',
    });
  });

  it('parseNativeTabletSample forces zero pressure on native up phase', () => {
    const sample = parseNativeTabletSample(
      createNativePoint({ phase: 'up', pressure_0_1: 0.7, source: 'macnative' })
    );
    expect(sample.phase).toBe('up');
    expect(sample.source).toBe('macnative');
    expect(sample.pressure).toBe(0);
  });

  it('resolveNativeStrokePoints keeps only latest stroke from explicit down', () => {
    const buffered = [
      createNativePoint({ seq: 26, stroke_id: 1, phase: 'up', x_px: 400, y_px: 300 }),
      createNativePoint({ seq: 27, stroke_id: 2, phase: 'down', x_px: 510, y_px: 180 }),
      createNativePoint({ seq: 28, stroke_id: 2, phase: 'move', x_px: 512, y_px: 182 }),
      createNativePoint({ seq: 29, stroke_id: 2, phase: 'up', x_px: 512, y_px: 182 }),
    ];
    const resolved = resolveNativeStrokePoints(buffered, null);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.seq).toBe(27);
    expect(resolved[0]?.phase).toBe('down');
    expect(resolved[1]?.seq).toBe(28);
    expect(resolved[1]?.phase).toBe('move');
  });

  it('resolveNativeStrokePoints returns empty when no down arrived yet', () => {
    const buffered = [createNativePoint({ seq: 33, stroke_id: 3, phase: 'up' })];
    const resolved = resolveNativeStrokePoints(buffered, null);
    expect(resolved).toHaveLength(0);
  });

  it('resolveNativeStrokePoints falls back to currentPoint only when it is down/move with down present', () => {
    const current = createNativePoint({ seq: 22, phase: 'down' });
    const resolved = resolveNativeStrokePoints([], current);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.seq).toBe(22);
  });

  it('mapNativeWindowPxToCanvasPoint maps window client px to canvas px', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 500;
    const mapped = mapNativeWindowPxToCanvasPoint(
      canvas,
      { left: 10, top: 20, width: 500, height: 250 },
      260,
      145
    );
    expect(mapped.x).toBeCloseTo(500, 6);
    expect(mapped.y).toBeCloseTo(250, 6);
  });

  it('tracks macnative out-of-view coordinate diagnostics', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 500;
    mapNativeWindowPxToCanvasPoint(
      canvas,
      { left: 10, top: 20, width: 500, height: 250 },
      800,
      600,
      'macnative'
    );
    const diagnostics = getNativeCoordinateDiagnosticsSnapshot();
    expect(diagnostics.total_count).toBe(1);
    expect(diagnostics.out_of_view_count).toBe(1);
    expect(diagnostics.macnative_out_of_view_count).toBe(1);
  });

  it('recognizes native streaming backends', () => {
    expect(isNativeTabletStreamingBackend('wintab')).toBe(true);
    expect(isNativeTabletStreamingBackend('macnative')).toBe(true);
    expect(isNativeTabletStreamingBackend('pointerevent')).toBe(false);
  });

  it('isNativeTabletStreamingState requires streaming=true', () => {
    expect(
      isNativeTabletStreamingState({
        isStreaming: true,
        activeBackend: 'wintab',
        backend: 'pointerevent',
      })
    ).toBe(true);
    expect(
      isNativeTabletStreamingState({
        isStreaming: false,
        activeBackend: 'wintab',
        backend: 'wintab',
      })
    ).toBe(false);
  });
});

import type { TabletInputPoint } from '@/stores/tablet';

type UnifiedInputSource = 'wintab' | 'macnative' | 'pointerevent';
type UnifiedInputPhase = 'hover' | 'down' | 'move' | 'up';

export interface UnifiedPointerEventV3 {
  seq: number;
  stroke_id: number;
  pointer_id: number;
  source: UnifiedInputSource;
  phase: UnifiedInputPhase;
  x_px: number;
  y_px: number;
  pressure_0_1: number;
  tilt_x_deg: number;
  tilt_y_deg: number;
  rotation_deg: number;
  host_time_us: number;
  device_time_us: number;
}

export interface MacnativeSessionCursorV3 {
  seq: number;
  bufferEpoch: number;
  activeStrokeId: number | null;
}

export interface MacnativeSessionDiagnosticsDelta {
  mixed_source_reject_count: number;
  native_down_without_seed_count: number;
  stroke_tail_drop_count: number;
  seq_rewind_recovery_fail_count: number;
}

export interface MacnativeSessionRouterV3Input {
  points: TabletInputPoint[];
  cursor: MacnativeSessionCursorV3;
  bufferEpoch: number;
}

export interface MacnativeSessionRouterV3Result {
  events: UnifiedPointerEventV3[];
  nextCursor: MacnativeSessionCursorV3;
  diagnosticsDelta: MacnativeSessionDiagnosticsDelta;
}

const EMPTY_DELTA: MacnativeSessionDiagnosticsDelta = {
  mixed_source_reject_count: 0,
  native_down_without_seed_count: 0,
  stroke_tail_drop_count: 0,
  seq_rewind_recovery_fail_count: 0,
};

export function createMacnativeSessionCursorV3(
  overrides: Partial<MacnativeSessionCursorV3> = {}
): MacnativeSessionCursorV3 {
  return {
    seq: overrides.seq ?? 0,
    bufferEpoch: overrides.bufferEpoch ?? 0,
    activeStrokeId: overrides.activeStrokeId ?? null,
  };
}

function normalizeSource(source: TabletInputPoint['source']): UnifiedInputSource {
  if (source === 'wintab') return source;
  if (source === 'macnative') return source;
  return 'pointerevent';
}

function toUnifiedEvent(point: TabletInputPoint): UnifiedPointerEventV3 {
  return {
    seq: point.seq,
    stroke_id: point.stroke_id,
    pointer_id: point.pointer_id,
    source: normalizeSource(point.source),
    phase: point.phase,
    x_px: point.x_px,
    y_px: point.y_px,
    pressure_0_1: point.pressure_0_1,
    tilt_x_deg: point.tilt_x_deg,
    tilt_y_deg: point.tilt_y_deg,
    rotation_deg: point.rotation_deg,
    host_time_us: point.host_time_us,
    device_time_us: point.device_time_us,
  };
}

export class MacnativeSessionRouterV3 {
  private readonly strokeSource = new Map<number, UnifiedInputSource>();

  reset(): void {
    this.strokeSource.clear();
  }

  route(input: MacnativeSessionRouterV3Input): MacnativeSessionRouterV3Result {
    const diagnosticsDelta: MacnativeSessionDiagnosticsDelta = { ...EMPTY_DELTA };
    const events: UnifiedPointerEventV3[] = [];
    let nextCursor: MacnativeSessionCursorV3 = { ...input.cursor };

    if (input.bufferEpoch !== input.cursor.bufferEpoch) {
      this.reset();
      nextCursor = createMacnativeSessionCursorV3({
        seq: 0,
        bufferEpoch: input.bufferEpoch,
        activeStrokeId: null,
      });
      const firstNonHover = input.points.find((point) => point.phase !== 'hover');
      if (firstNonHover && firstNonHover.phase !== 'down') {
        diagnosticsDelta.seq_rewind_recovery_fail_count += 1;
      }
    }

    if (input.points.length <= 0) {
      return { events, nextCursor, diagnosticsDelta };
    }

    for (const point of input.points) {
      if (point.phase === 'hover') {
        if (point.seq > nextCursor.seq) {
          nextCursor.seq = point.seq;
        }
        continue;
      }
      if (point.seq <= nextCursor.seq) {
        continue;
      }
      nextCursor.seq = point.seq;

      const source = normalizeSource(point.source);
      const existingSource = this.strokeSource.get(point.stroke_id);
      if (existingSource && existingSource !== source) {
        diagnosticsDelta.mixed_source_reject_count += 1;
        continue;
      }
      if (!existingSource) {
        this.strokeSource.set(point.stroke_id, source);
      }

      if (point.phase === 'down') {
        if (nextCursor.activeStrokeId !== null && nextCursor.activeStrokeId !== point.stroke_id) {
          diagnosticsDelta.stroke_tail_drop_count += 1;
        }
        nextCursor.activeStrokeId = point.stroke_id;
        events.push(toUnifiedEvent(point));
        continue;
      }

      if (nextCursor.activeStrokeId === null) {
        diagnosticsDelta.native_down_without_seed_count += 1;
        if (point.phase === 'up') {
          this.strokeSource.delete(point.stroke_id);
        }
        continue;
      }

      if (point.stroke_id !== nextCursor.activeStrokeId) {
        diagnosticsDelta.stroke_tail_drop_count += 1;
        if (point.phase === 'up') {
          this.strokeSource.delete(point.stroke_id);
        }
        continue;
      }

      events.push(toUnifiedEvent(point));
      if (point.phase === 'up') {
        this.strokeSource.delete(point.stroke_id);
        nextCursor.activeStrokeId = null;
      }
    }

    return { events, nextCursor, diagnosticsDelta };
  }
}

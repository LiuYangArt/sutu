import type { TabletInputPoint } from '@/stores/tablet';

export type UnifiedInputSourceV3 = 'wintab' | 'macnative' | 'pointerevent';
export type UnifiedInputPhaseV3 = 'hover' | 'down' | 'move' | 'up';

export interface UnifiedIngressPointV3 {
  seq: number;
  stroke_id: number;
  pointer_id: number;
  source: UnifiedInputSourceV3;
  phase: UnifiedInputPhaseV3;
  x_px: number;
  y_px: number;
  pressure_0_1: number;
  tilt_x_deg: number;
  tilt_y_deg: number;
  rotation_deg: number;
  host_time_us: number;
  device_time_us: number;
}

export interface IngressCursorV3 {
  seq: number;
  bufferEpoch: number;
  activeStrokeId: number | null;
  activeSource: UnifiedInputSourceV3 | null;
}

export interface IngressGateStateV3 {
  spacePressed: boolean;
  isPanning: boolean;
  isZooming: boolean;
  currentTool: string;
  isCanvasInputLocked: boolean;
}

export interface UnifiedIngressDiagnosticsDeltaV3 {
  mixed_source_reject_count: number;
  native_down_without_seed_count: number;
  stroke_tail_drop_count: number;
  seq_rewind_recovery_fail_count: number;
  gesture_block_drop_count: number;
}

export interface UnifiedSessionRouterV3Input {
  points: UnifiedIngressPointV3[];
  cursor: IngressCursorV3;
  bufferEpoch: number;
  gateState: IngressGateStateV3;
}

export interface UnifiedSessionRouterV3Result {
  acceptedEvents: UnifiedIngressPointV3[];
  nextCursor: IngressCursorV3;
  diagnosticsDelta: UnifiedIngressDiagnosticsDeltaV3;
}

const EMPTY_DIAGNOSTICS_DELTA: UnifiedIngressDiagnosticsDeltaV3 = {
  mixed_source_reject_count: 0,
  native_down_without_seed_count: 0,
  stroke_tail_drop_count: 0,
  seq_rewind_recovery_fail_count: 0,
  gesture_block_drop_count: 0,
};

const DEFAULT_GATE_STATE: IngressGateStateV3 = {
  spacePressed: false,
  isPanning: false,
  isZooming: false,
  currentTool: 'brush',
  isCanvasInputLocked: false,
};

function normalizeSource(source: TabletInputPoint['source']): UnifiedInputSourceV3 {
  if (source === 'wintab') return 'wintab';
  if (source === 'macnative') return 'macnative';
  return 'pointerevent';
}

function toUnifiedIngressPoint(point: TabletInputPoint): UnifiedIngressPointV3 {
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

function shouldBlockByGate(gateState: IngressGateStateV3): boolean {
  if (gateState.isCanvasInputLocked) return true;
  if (gateState.spacePressed || gateState.isPanning || gateState.isZooming) return true;
  return gateState.currentTool === 'move';
}

export function createIngressCursorV3(overrides: Partial<IngressCursorV3> = {}): IngressCursorV3 {
  return {
    seq: overrides.seq ?? 0,
    bufferEpoch: overrides.bufferEpoch ?? 0,
    activeStrokeId: overrides.activeStrokeId ?? null,
    activeSource: overrides.activeSource ?? null,
  };
}

export function createIngressGateStateV3(
  overrides: Partial<IngressGateStateV3> = {}
): IngressGateStateV3 {
  return {
    ...DEFAULT_GATE_STATE,
    ...overrides,
  };
}

export function normalizeTabletPointsToIngress(
  points: TabletInputPoint[]
): UnifiedIngressPointV3[] {
  return points.map(toUnifiedIngressPoint);
}

export class UnifiedSessionRouterV3 {
  private readonly strokeSource = new Map<number, UnifiedInputSourceV3>();

  reset(): void {
    this.strokeSource.clear();
  }

  route(input: UnifiedSessionRouterV3Input): UnifiedSessionRouterV3Result {
    const diagnosticsDelta: UnifiedIngressDiagnosticsDeltaV3 = { ...EMPTY_DIAGNOSTICS_DELTA };
    const acceptedEvents: UnifiedIngressPointV3[] = [];
    let nextCursor: IngressCursorV3 = { ...input.cursor };

    if (input.bufferEpoch !== input.cursor.bufferEpoch) {
      this.reset();
      nextCursor = createIngressCursorV3({
        seq: 0,
        bufferEpoch: input.bufferEpoch,
        activeStrokeId: null,
        activeSource: null,
      });
      const firstNonHover = input.points.find((point) => point.phase !== 'hover');
      if (firstNonHover && firstNonHover.phase !== 'down') {
        diagnosticsDelta.seq_rewind_recovery_fail_count += 1;
      }
    }

    if (input.points.length === 0) {
      return { acceptedEvents, nextCursor, diagnosticsDelta };
    }

    const blockedByGate = shouldBlockByGate(input.gateState);

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

      if (blockedByGate) {
        diagnosticsDelta.gesture_block_drop_count += 1;
        if (point.phase === 'up' && nextCursor.activeStrokeId === point.stroke_id) {
          nextCursor.activeStrokeId = null;
          nextCursor.activeSource = null;
        }
        continue;
      }

      const existingSource = this.strokeSource.get(point.stroke_id);
      if (existingSource && existingSource !== point.source) {
        diagnosticsDelta.mixed_source_reject_count += 1;
        continue;
      }
      if (!existingSource) {
        this.strokeSource.set(point.stroke_id, point.source);
      }

      if (point.phase === 'down') {
        if (nextCursor.activeStrokeId !== null && nextCursor.activeStrokeId !== point.stroke_id) {
          diagnosticsDelta.stroke_tail_drop_count += 1;
        }
        nextCursor.activeStrokeId = point.stroke_id;
        nextCursor.activeSource = point.source;
        acceptedEvents.push(point);
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

      acceptedEvents.push(point);
      if (point.phase === 'up') {
        this.strokeSource.delete(point.stroke_id);
        nextCursor.activeStrokeId = null;
        nextCursor.activeSource = null;
      }
    }

    return { acceptedEvents, nextCursor, diagnosticsDelta };
  }
}

import type { TabletInputPoint } from '@/stores/tablet';
import {
  UnifiedSessionRouterV3,
  createIngressCursorV3,
  createIngressGateStateV3,
  normalizeTabletPointsToIngress,
  type IngressCursorV3,
  type UnifiedIngressDiagnosticsDeltaV3,
  type UnifiedIngressPointV3,
} from './unifiedSessionRouterV3';

export type UnifiedPointerEventV3 = UnifiedIngressPointV3;

export interface MacnativeSessionCursorV3 extends Pick<
  IngressCursorV3,
  'seq' | 'bufferEpoch' | 'activeStrokeId'
> {}

export interface MacnativeSessionDiagnosticsDelta extends Pick<
  UnifiedIngressDiagnosticsDeltaV3,
  | 'mixed_source_reject_count'
  | 'native_down_without_seed_count'
  | 'stroke_tail_drop_count'
  | 'seq_rewind_recovery_fail_count'
> {}

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

export function createMacnativeSessionCursorV3(
  overrides: Partial<MacnativeSessionCursorV3> = {}
): MacnativeSessionCursorV3 {
  const cursor = createIngressCursorV3(overrides);
  return {
    seq: cursor.seq,
    bufferEpoch: cursor.bufferEpoch,
    activeStrokeId: cursor.activeStrokeId,
  };
}

export class MacnativeSessionRouterV3 {
  private readonly router = new UnifiedSessionRouterV3();

  reset(): void {
    this.router.reset();
  }

  route(input: MacnativeSessionRouterV3Input): MacnativeSessionRouterV3Result {
    const routeResult = this.router.route({
      points: normalizeTabletPointsToIngress(input.points),
      cursor: createIngressCursorV3({
        seq: input.cursor.seq,
        bufferEpoch: input.cursor.bufferEpoch,
        activeStrokeId: input.cursor.activeStrokeId,
      }),
      bufferEpoch: input.bufferEpoch,
      gateState: createIngressGateStateV3(),
    });

    return {
      events: routeResult.acceptedEvents,
      nextCursor: {
        seq: routeResult.nextCursor.seq,
        bufferEpoch: routeResult.nextCursor.bufferEpoch,
        activeStrokeId: routeResult.nextCursor.activeStrokeId,
      },
      diagnosticsDelta: {
        mixed_source_reject_count: routeResult.diagnosticsDelta.mixed_source_reject_count,
        native_down_without_seed_count: routeResult.diagnosticsDelta.native_down_without_seed_count,
        stroke_tail_drop_count: routeResult.diagnosticsDelta.stroke_tail_drop_count,
        seq_rewind_recovery_fail_count: routeResult.diagnosticsDelta.seq_rewind_recovery_fail_count,
      },
    };
  }
}

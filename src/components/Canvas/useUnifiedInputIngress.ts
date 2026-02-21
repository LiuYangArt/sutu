import { useCallback, useRef } from 'react';
import { readPointBufferSince, type TabletInputPoint } from '@/stores/tablet';
import {
  UnifiedSessionRouterV3,
  createIngressCursorV3,
  createIngressGateStateV3,
  normalizeTabletPointsToIngress,
  type IngressCursorV3,
  type IngressGateStateV3,
  type UnifiedIngressDiagnosticsDeltaV3,
  type UnifiedIngressPointV3,
} from '@/engine/kritaParityInput/unifiedSessionRouterV3';
import { logTabletTrace } from '@/utils/tabletTrace';
import { recordIngressGateDrop } from './inputUtils';

export interface UnifiedNativeIngressBatch {
  rawPoints: TabletInputPoint[];
  events: UnifiedIngressPointV3[];
  cursor: IngressCursorV3;
  bufferEpoch: number;
  diagnosticsDelta: UnifiedIngressDiagnosticsDeltaV3;
}

export interface UnifiedPointerIngressBatch {
  events: UnifiedIngressPointV3[];
  cursor: IngressCursorV3;
  diagnosticsDelta: UnifiedIngressDiagnosticsDeltaV3;
}

interface UseUnifiedInputIngressParams {
  getGateState: () => IngressGateStateV3;
}

function emptyDiagnostics(): UnifiedIngressDiagnosticsDeltaV3 {
  return {
    mixed_source_reject_count: 0,
    native_down_without_seed_count: 0,
    stroke_tail_drop_count: 0,
    seq_rewind_recovery_fail_count: 0,
    gesture_block_drop_count: 0,
  };
}

function emitDiagnosticsTrace(stage: string, delta: UnifiedIngressDiagnosticsDeltaV3): void {
  if (delta.gesture_block_drop_count > 0) {
    logTabletTrace('frontend.ingress.drop_gesture', {
      stage,
      count: delta.gesture_block_drop_count,
    });
  }
  if (delta.mixed_source_reject_count > 0) {
    logTabletTrace('frontend.anomaly.native_mixed_source_reject', {
      stage,
      count: delta.mixed_source_reject_count,
    });
  }
  if (delta.native_down_without_seed_count > 0) {
    logTabletTrace('frontend.anomaly.native_down_without_seed', {
      stage,
      count: delta.native_down_without_seed_count,
    });
  }
  if (delta.stroke_tail_drop_count > 0) {
    logTabletTrace('frontend.anomaly.native_stroke_tail_drop', {
      stage,
      count: delta.stroke_tail_drop_count,
    });
  }
  if (delta.seq_rewind_recovery_fail_count > 0) {
    logTabletTrace('frontend.anomaly.native_seq_rewind_recovery_fail', {
      stage,
      count: delta.seq_rewind_recovery_fail_count,
    });
  }
}

export function useUnifiedInputIngress({ getGateState }: UseUnifiedInputIngressParams) {
  const routerRef = useRef<UnifiedSessionRouterV3>(new UnifiedSessionRouterV3());
  const cursorRef = useRef<IngressCursorV3>(createIngressCursorV3());
  const syntheticSeqRef = useRef<number>(0);

  const resetUnifiedIngress = useCallback(() => {
    const bufferEpoch = cursorRef.current.bufferEpoch;
    routerRef.current.reset();
    cursorRef.current = createIngressCursorV3({
      seq: 0,
      bufferEpoch,
      activeStrokeId: null,
      activeSource: null,
    });
    syntheticSeqRef.current = 0;
  }, []);

  const consumeNativeRoutedPoints = useCallback(
    (stage: string): UnifiedNativeIngressBatch => {
      const readCursor = cursorRef.current.seq;
      const readResult = readPointBufferSince(readCursor);
      const effectiveBufferEpoch =
        typeof readResult.bufferEpoch === 'number' && Number.isFinite(readResult.bufferEpoch)
          ? readResult.bufferEpoch
          : cursorRef.current.bufferEpoch;
      const gateState = getGateState();

      const routeResult = routerRef.current.route({
        points: normalizeTabletPointsToIngress(readResult.points),
        cursor: cursorRef.current,
        bufferEpoch: effectiveBufferEpoch,
        gateState,
      });

      if (routeResult.diagnosticsDelta.gesture_block_drop_count > 0) {
        recordIngressGateDrop(gateState, routeResult.diagnosticsDelta.gesture_block_drop_count);
      }
      cursorRef.current = routeResult.nextCursor;
      syntheticSeqRef.current = Math.max(syntheticSeqRef.current, routeResult.nextCursor.seq);
      emitDiagnosticsTrace(stage, routeResult.diagnosticsDelta);

      return {
        rawPoints: readResult.points,
        events: routeResult.acceptedEvents,
        cursor: routeResult.nextCursor,
        bufferEpoch: effectiveBufferEpoch,
        diagnosticsDelta: routeResult.diagnosticsDelta,
      };
    },
    [getGateState]
  );

  const routePointerIngressPoints = useCallback(
    (stage: string, points: UnifiedIngressPointV3[]): UnifiedPointerIngressBatch => {
      if (points.length <= 0) {
        return {
          events: [],
          cursor: cursorRef.current,
          diagnosticsDelta: emptyDiagnostics(),
        };
      }

      let nextSyntheticSeq = Math.max(syntheticSeqRef.current, cursorRef.current.seq);
      const sequencedPoints = points.map((point) => {
        const preferredSeq = Number.isFinite(point.seq) && point.seq > 0 ? point.seq : 0;
        if (preferredSeq > nextSyntheticSeq) {
          nextSyntheticSeq = preferredSeq;
        } else {
          nextSyntheticSeq += 1;
        }
        return {
          ...point,
          seq: nextSyntheticSeq,
        };
      });

      syntheticSeqRef.current = nextSyntheticSeq;
      const gateState = getGateState();

      const routeResult = routerRef.current.route({
        points: sequencedPoints,
        cursor: cursorRef.current,
        bufferEpoch: cursorRef.current.bufferEpoch,
        gateState,
      });

      if (routeResult.diagnosticsDelta.gesture_block_drop_count > 0) {
        recordIngressGateDrop(gateState, routeResult.diagnosticsDelta.gesture_block_drop_count);
      }
      cursorRef.current = routeResult.nextCursor;
      emitDiagnosticsTrace(stage, routeResult.diagnosticsDelta);

      return {
        events: routeResult.acceptedEvents,
        cursor: routeResult.nextCursor,
        diagnosticsDelta: routeResult.diagnosticsDelta,
      };
    },
    [getGateState]
  );

  const getCursorSnapshot = useCallback((): IngressCursorV3 => {
    return { ...cursorRef.current };
  }, []);

  return {
    consumeNativeRoutedPoints,
    routePointerIngressPoints,
    getCursorSnapshot,
    resetUnifiedIngress,
  };
}

export {
  createIngressCursorV3,
  createIngressGateStateV3,
  type IngressCursorV3,
  type IngressGateStateV3,
  type UnifiedIngressDiagnosticsDeltaV3,
  type UnifiedIngressPointV3,
};

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import {
  buildSingleChannelCurvePath,
  CHANNEL_MAX,
  canDeletePointAtIndex,
  clamp,
  computeOvershootPixels,
  findHitPointId,
  fromGraphPoint,
  fromGraphPointRaw,
  getPointDragRange,
  type SingleChannelCurvePoint,
} from './singleChannelCore';

interface DragState {
  pointId: string;
  moved: boolean;
  canDeleteByDragOut: boolean;
  commitToken: unknown;
}

const SAME_X_AXIS_TOLERANCE = 1;

interface DragCommitResult {
  moved: boolean;
  deleted: boolean;
  token: unknown;
}

export interface UseSingleChannelCurveEditorOptions<TPoint extends SingleChannelCurvePoint> {
  graphRef: RefObject<SVGSVGElement | null>;
  points: readonly TPoint[];
  setPoints: (updater: (prev: TPoint[]) => TPoint[]) => void;
  selectedPointId: string | null;
  setSelectedPointId: (pointId: string | null) => void;
  createPointId: () => string;
  pointHitRadiusPx: number;
  dragDeleteOvershootThresholdPx: number;
  curveSampleCount?: number;
  graphSize?: number;
  isDeleteKeyEnabled?: () => boolean;
  shouldIgnoreDeleteKeyTarget?: (target: EventTarget | null) => boolean;
  onBeforeAddPoint?: () => void;
  onBeforeDeleteByKey?: () => void;
  onDragStart?: (pointId: string) => unknown;
  onDragCommit?: (result: DragCommitResult) => void;
}

export interface UseSingleChannelCurveEditorResult {
  curvePath: string;
  handleGraphPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => void;
}

export function useSingleChannelCurveEditor<TPoint extends SingleChannelCurvePoint>({
  graphRef,
  points,
  setPoints,
  selectedPointId,
  setSelectedPointId,
  createPointId,
  pointHitRadiusPx,
  dragDeleteOvershootThresholdPx,
  curveSampleCount = 128,
  graphSize = 256,
  isDeleteKeyEnabled,
  shouldIgnoreDeleteKeyTarget,
  onBeforeAddPoint,
  onBeforeDeleteByKey,
  onDragStart,
  onDragCommit,
}: UseSingleChannelCurveEditorOptions<TPoint>): UseSingleChannelCurveEditorResult {
  const dragRef = useRef<DragState | null>(null);
  const pointsRef = useRef(points);
  const selectedPointIdRef = useRef<string | null>(selectedPointId);

  useEffect(() => {
    pointsRef.current = points;
  }, [points]);

  useEffect(() => {
    selectedPointIdRef.current = selectedPointId;
  }, [selectedPointId]);

  const updatePoints = useCallback(
    (updater: (prev: TPoint[]) => TPoint[]) => {
      setPoints((prev) => {
        const next = updater(prev);
        return next === prev ? prev : next;
      });
    },
    [setPoints]
  );

  const curvePath = useMemo(
    () =>
      buildSingleChannelCurvePath(points, {
        sampleCount: curveSampleCount,
        graphSize,
      }),
    [curveSampleCount, graphSize, points]
  );

  const deleteDraggedPoint = useCallback(
    (drag: DragState): boolean => {
      let deleted = false;
      updatePoints((prev) => {
        const removeIndex = prev.findIndex((point) => point.id === drag.pointId);
        if (!canDeletePointAtIndex(removeIndex, prev.length)) return prev;
        deleted = true;
        return prev.filter((point) => point.id !== drag.pointId);
      });
      if (!deleted) return false;

      setSelectedPointId(null);
      onDragCommit?.({
        moved: drag.moved,
        deleted: true,
        token: drag.commitToken,
      });
      dragRef.current = null;
      return true;
    },
    [onDragCommit, setSelectedPointId, updatePoints]
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      const graph = graphRef.current;
      if (!drag || !graph) return;

      const rect = graph.getBoundingClientRect();
      const rawPoint = fromGraphPointRaw(event.clientX, event.clientY, rect);
      const livePoints = pointsRef.current;

      if (drag.canDeleteByDragOut) {
        const index = livePoints.findIndex((point) => point.id === drag.pointId);
        if (index >= 0) {
          const range = getPointDragRange(livePoints, index);
          const pixelsPerXUnit = rect.width / CHANNEL_MAX;
          const pixelsPerYUnit = rect.height / CHANNEL_MAX;
          const overshootX = computeOvershootPixels(
            rawPoint.x,
            range.minX,
            range.maxX,
            pixelsPerXUnit
          );
          const overshootY = computeOvershootPixels(
            rawPoint.y,
            range.minY,
            range.maxY,
            pixelsPerYUnit
          );
          const didReachDeleteThreshold =
            Math.max(overshootX, overshootY) >= dragDeleteOvershootThresholdPx;
          if (didReachDeleteThreshold && deleteDraggedPoint(drag)) {
            return;
          }
        }
      }

      const nextPoint = fromGraphPoint(event.clientX, event.clientY, rect);
      let didMove = false;
      updatePoints((prev) => {
        const index = prev.findIndex((point) => point.id === drag.pointId);
        if (index < 0) return prev;
        const current = prev[index];
        if (!current) return prev;
        const range = getPointDragRange(prev, index);
        const targetX = clamp(nextPoint.x, range.minX, range.maxX);
        const targetY = clamp(nextPoint.y, range.minY, range.maxY);
        if (targetX === current.x && targetY === current.y) return prev;

        didMove = true;
        const next = [...prev];
        next[index] = {
          ...current,
          x: clamp(targetX, 0, 255),
          y: clamp(targetY, 0, 255),
        };
        return next;
      });

      if (didMove && dragRef.current) {
        dragRef.current.moved = true;
      }
    };

    const onPointerUp = (): void => {
      const drag = dragRef.current;
      if (!drag) return;

      onDragCommit?.({
        moved: drag.moved,
        deleted: false,
        token: drag.commitToken,
      });
      dragRef.current = null;
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [deleteDraggedPoint, dragDeleteOvershootThresholdPx, graphRef, onDragCommit, updatePoints]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Delete') return;
      if (isDeleteKeyEnabled && !isDeleteKeyEnabled()) return;
      if (shouldIgnoreDeleteKeyTarget?.(event.target)) return;

      const pointId = selectedPointIdRef.current;
      if (!pointId) return;
      const livePoints = pointsRef.current;
      const index = livePoints.findIndex((point) => point.id === pointId);
      if (!canDeletePointAtIndex(index, livePoints.length)) return;

      event.preventDefault();
      event.stopPropagation();
      onBeforeDeleteByKey?.();
      updatePoints((prev) => prev.filter((point) => point.id !== pointId));
      setSelectedPointId(null);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [
    isDeleteKeyEnabled,
    onBeforeDeleteByKey,
    setSelectedPointId,
    shouldIgnoreDeleteKeyTarget,
    updatePoints,
  ]);

  const handleGraphPointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const graph = graphRef.current;
      if (!graph) return;

      const rect = graph.getBoundingClientRect();
      const clickPoint = fromGraphPoint(event.clientX, event.clientY, rect);
      const livePoints = pointsRef.current;
      const hitPointId = findHitPointId(
        livePoints,
        event.clientX,
        event.clientY,
        rect,
        pointHitRadiusPx
      );

      if (hitPointId) {
        const hitIndex = livePoints.findIndex((point) => point.id === hitPointId);
        setSelectedPointId(hitPointId);
        dragRef.current = {
          pointId: hitPointId,
          moved: false,
          canDeleteByDragOut: canDeletePointAtIndex(hitIndex, livePoints.length),
          commitToken: onDragStart?.(hitPointId),
        };
        return;
      }

      const sameXPoint = livePoints.find(
        (point) => Math.abs(point.x - clickPoint.x) <= SAME_X_AXIS_TOLERANCE
      );
      if (sameXPoint) {
        const existingIndex = livePoints.findIndex((point) => point.id === sameXPoint.id);
        setSelectedPointId(sameXPoint.id);
        dragRef.current = {
          pointId: sameXPoint.id,
          moved: false,
          canDeleteByDragOut: canDeletePointAtIndex(existingIndex, livePoints.length),
          commitToken: onDragStart?.(sameXPoint.id),
        };
        return;
      }

      onBeforeAddPoint?.();
      const pointId = createPointId();
      const insertionIndex = livePoints.findIndex((point) => point.x > clickPoint.x);
      const newPointIndex = insertionIndex === -1 ? livePoints.length : insertionIndex;
      updatePoints((prev) => {
        const nextPoint = { id: pointId, x: clickPoint.x, y: clickPoint.y } as TPoint;
        const next = [...prev, nextPoint];
        next.sort((a, b) => a.x - b.x);
        return next;
      });
      setSelectedPointId(pointId);
      dragRef.current = {
        pointId,
        moved: false,
        canDeleteByDragOut: canDeletePointAtIndex(newPointIndex, livePoints.length + 1),
        commitToken: null,
      };
      event.preventDefault();
    },
    [
      createPointId,
      graphRef,
      onBeforeAddPoint,
      onDragStart,
      pointHitRadiusPx,
      setSelectedPointId,
      updatePoints,
    ]
  );

  return {
    curvePath,
    handleGraphPointerDown,
  };
}

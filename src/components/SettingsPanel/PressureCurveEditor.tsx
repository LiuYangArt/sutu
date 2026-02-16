import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type PressureCurveControlPoint,
  normalizePressureCurvePoints,
} from '@/utils/pressureCurve';
import {
  DEFAULT_GRAPH_SIZE,
  toGraphX,
  toGraphY,
  type SingleChannelCurvePoint,
} from '@/components/CurveEditor/singleChannelCore';
import { useSingleChannelCurveEditor } from '@/components/CurveEditor/useSingleChannelCurveEditor';

const GRAPH_SIZE = DEFAULT_GRAPH_SIZE;
const GRID_DIVISIONS = 4;
const POINT_HIT_RADIUS_PX = 12;
const DRAG_DELETE_OVERSHOOT_THRESHOLD_PX = 18;

interface EditablePoint extends SingleChannelCurvePoint {}

function pointsEqual(
  a: readonly PressureCurveControlPoint[],
  b: readonly PressureCurveControlPoint[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const pa = a[i]!;
    const pb = b[i]!;
    if (Math.abs(pa.x - pb.x) > 1e-6 || Math.abs(pa.y - pb.y) > 1e-6) return false;
  }
  return true;
}

interface PressureCurveEditorProps {
  points: readonly PressureCurveControlPoint[];
  onChange: (points: PressureCurveControlPoint[]) => void;
}

export function PressureCurveEditor({ points, onChange }: PressureCurveEditorProps): JSX.Element {
  const graphRef = useRef<SVGSVGElement | null>(null);
  const idRef = useRef(0);

  const nextId = useCallback((): string => {
    idRef.current += 1;
    return `pressure-curve-point-${idRef.current}`;
  }, []);

  const toEditablePoints = useCallback(
    (input: readonly PressureCurveControlPoint[]): EditablePoint[] => {
      const normalized = normalizePressureCurvePoints(input);
      return normalized.map((point) => ({
        id: nextId(),
        x: point.x * 255,
        y: point.y * 255,
      }));
    },
    [nextId]
  );

  const [editablePoints, setEditablePoints] = useState<EditablePoint[]>(() =>
    toEditablePoints(points)
  );
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const applyingExternalUpdateRef = useRef(false);
  const lastExternalPointsRef = useRef<PressureCurveControlPoint[]>(
    normalizePressureCurvePoints(points)
  );

  const normalizedExternalPoints = useMemo(() => normalizePressureCurvePoints(points), [points]);
  const normalizedInternalPoints = useMemo(
    () =>
      normalizePressureCurvePoints(
        editablePoints.map((point) => ({
          x: point.x / 255,
          y: point.y / 255,
        }))
      ),
    [editablePoints]
  );

  useEffect(() => {
    const externalChanged = !pointsEqual(lastExternalPointsRef.current, normalizedExternalPoints);
    if (!externalChanged) return;
    lastExternalPointsRef.current = normalizedExternalPoints.map((point) => ({ ...point }));
    if (pointsEqual(normalizedExternalPoints, normalizedInternalPoints)) return;
    applyingExternalUpdateRef.current = true;
    setEditablePoints(toEditablePoints(normalizedExternalPoints));
    setSelectedPointId(null);
  }, [normalizedExternalPoints, normalizedInternalPoints, toEditablePoints]);

  useEffect(() => {
    if (applyingExternalUpdateRef.current) {
      applyingExternalUpdateRef.current = false;
      return;
    }
    if (pointsEqual(normalizedExternalPoints, normalizedInternalPoints)) return;
    onChange(normalizedInternalPoints);
  }, [normalizedExternalPoints, normalizedInternalPoints, onChange]);

  const setCurvePoints = useCallback((updater: (prev: EditablePoint[]) => EditablePoint[]) => {
    setEditablePoints((prev) => {
      const next = updater(prev);
      return next === prev ? prev : next;
    });
  }, []);

  const { curvePath, handleGraphPointerDown } = useSingleChannelCurveEditor({
    graphRef,
    points: editablePoints,
    setPoints: setCurvePoints,
    selectedPointId,
    setSelectedPointId,
    createPointId: nextId,
    pointHitRadiusPx: POINT_HIT_RADIUS_PX,
    dragDeleteOvershootThresholdPx: DRAG_DELETE_OVERSHOOT_THRESHOLD_PX,
    curveSampleCount: 128,
    graphSize: GRAPH_SIZE,
  });

  return (
    <svg
      ref={graphRef}
      className="pressure-curve-editor"
      viewBox={`0 0 ${GRAPH_SIZE} ${GRAPH_SIZE}`}
      role="img"
      aria-label="Pressure curve editor"
      onPointerDown={handleGraphPointerDown}
    >
      <rect
        x={0}
        y={0}
        width={GRAPH_SIZE}
        height={GRAPH_SIZE}
        className="pressure-curve-editor__bg"
      />
      {Array.from({ length: GRID_DIVISIONS + 1 }).map((_, index) => {
        const pos = (GRAPH_SIZE / GRID_DIVISIONS) * index;
        return (
          <g key={index}>
            <line
              x1={pos}
              y1={0}
              x2={pos}
              y2={GRAPH_SIZE}
              className="pressure-curve-editor__grid"
            />
            <line
              x1={0}
              y1={pos}
              x2={GRAPH_SIZE}
              y2={pos}
              className="pressure-curve-editor__grid"
            />
          </g>
        );
      })}
      <line
        x1={0}
        y1={GRAPH_SIZE}
        x2={GRAPH_SIZE}
        y2={0}
        className="pressure-curve-editor__baseline"
      />
      <path
        d={curvePath}
        className="pressure-curve-editor__curve"
        shapeRendering="geometricPrecision"
      />
      {editablePoints.map((point) => (
        <circle
          key={point.id}
          cx={toGraphX(point.x, GRAPH_SIZE)}
          cy={toGraphY(point.y, GRAPH_SIZE)}
          r={point.id === selectedPointId ? 4.5 : 3.5}
          className={
            point.id === selectedPointId
              ? 'pressure-curve-editor__point pressure-curve-editor__point--selected'
              : 'pressure-curve-editor__point'
          }
        />
      ))}
    </svg>
  );
}

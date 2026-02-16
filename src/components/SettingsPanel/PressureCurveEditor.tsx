import {
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { buildCurveEvaluator } from '@/utils/curvesRenderer';
import {
  type PressureCurveControlPoint,
  normalizePressureCurvePoints,
} from '@/utils/pressureCurve';

const GRAPH_WIDTH = 360;
const GRAPH_HEIGHT = 180;
const GRAPH_PADDING = 14;
const HIT_RADIUS_PX = 14;
const INTERNAL_MIN_X_GAP = 0.01;
const CURVE_SAMPLES = 96;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toGraphX(value: number): number {
  const innerWidth = GRAPH_WIDTH - GRAPH_PADDING * 2;
  return GRAPH_PADDING + clamp01(value) * innerWidth;
}

function toGraphY(value: number): number {
  const innerHeight = GRAPH_HEIGHT - GRAPH_PADDING * 2;
  return GRAPH_HEIGHT - GRAPH_PADDING - clamp01(value) * innerHeight;
}

function fromClientPoint(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  const localX = ((clientX - rect.left) / Math.max(1, rect.width)) * GRAPH_WIDTH;
  const localY = ((clientY - rect.top) / Math.max(1, rect.height)) * GRAPH_HEIGHT;
  const innerWidth = GRAPH_WIDTH - GRAPH_PADDING * 2;
  const innerHeight = GRAPH_HEIGHT - GRAPH_PADDING * 2;

  const normalizedX = clamp01((localX - GRAPH_PADDING) / Math.max(1e-6, innerWidth));
  const normalizedY = clamp01(
    (GRAPH_HEIGHT - GRAPH_PADDING - localY) / Math.max(1e-6, innerHeight)
  );

  return { x: normalizedX, y: normalizedY };
}

function findNearestPointIndex(
  points: readonly PressureCurveControlPoint[],
  graphX: number,
  graphY: number
): number {
  const radiusSq = HIT_RADIUS_PX * HIT_RADIUS_PX;
  let bestIndex = -1;
  let bestDistanceSq = radiusSq;

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]!;
    const dx = toGraphX(point.x) - graphX;
    const dy = toGraphY(point.y) - graphY;
    const distSq = dx * dx + dy * dy;
    if (distSq <= bestDistanceSq) {
      bestDistanceSq = distSq;
      bestIndex = i;
    }
  }

  return bestIndex;
}

interface PressureCurveEditorProps {
  points: readonly PressureCurveControlPoint[];
  onChange: (points: PressureCurveControlPoint[]) => void;
}

export function PressureCurveEditor({ points, onChange }: PressureCurveEditorProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const normalizedPoints = useMemo(() => normalizePressureCurvePoints(points), [points]);

  const curvePath = useMemo(() => {
    const evaluator = buildCurveEvaluator(
      normalizedPoints.map((point) => ({ x: point.x * 255, y: point.y * 255 })),
      { kernel: 'natural' }
    );

    let path = '';
    for (let i = 0; i < CURVE_SAMPLES; i += 1) {
      const t = i / (CURVE_SAMPLES - 1);
      const input = t * 255;
      const output = evaluator(input) / 255;
      const x = toGraphX(t);
      const y = toGraphY(output);
      path += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
    }
    return path;
  }, [normalizedPoints]);

  const commitDragAt = (index: number, x: number, y: number) => {
    const next = normalizedPoints.map((point) => ({ ...point }));
    const lastIndex = next.length - 1;

    if (index === 0) {
      next[index] = { x: 0, y: clamp01(y) };
    } else if (index === lastIndex) {
      next[index] = { x: 1, y: clamp01(y) };
    } else {
      const prevX = next[index - 1]!.x;
      const nextX = next[index + 1]!.x;
      const minX = Math.min(1, prevX + INTERNAL_MIN_X_GAP);
      const maxX = Math.max(minX, nextX - INTERNAL_MIN_X_GAP);
      next[index] = {
        x: Math.max(minX, Math.min(maxX, x)),
        y: clamp01(y),
      };
    }

    onChange(normalizePressureCurvePoints(next));
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;

    const graphX =
      ((event.clientX - svg.getBoundingClientRect().left) /
        Math.max(1, svg.getBoundingClientRect().width)) *
      GRAPH_WIDTH;
    const graphY =
      ((event.clientY - svg.getBoundingClientRect().top) /
        Math.max(1, svg.getBoundingClientRect().height)) *
      GRAPH_HEIGHT;
    const nearestIndex = findNearestPointIndex(normalizedPoints, graphX, graphY);
    const normalized = fromClientPoint(svg, event.clientX, event.clientY);

    let nextDragIndex = nearestIndex;
    if (nearestIndex < 0 && normalized.x > 0 && normalized.x < 1) {
      const insertIndex = normalizedPoints.findIndex((point) => point.x > normalized.x);
      const insertion = insertIndex < 0 ? normalizedPoints.length - 1 : insertIndex;
      const next = normalizedPoints.map((point) => ({ ...point }));
      next.splice(insertion, 0, normalized);
      const normalizedNext = normalizePressureCurvePoints(next);
      onChange(normalizedNext);
      nextDragIndex = normalizedNext.findIndex(
        (point) =>
          Math.abs(point.x - normalized.x) < 1e-6 && Math.abs(point.y - normalized.y) < 1e-6
      );
      if (nextDragIndex < 0) {
        nextDragIndex = insertion;
      }
    }

    if (nextDragIndex >= 0) {
      setDragIndex(nextDragIndex);
      if (typeof svg.setPointerCapture === 'function') {
        try {
          svg.setPointerCapture(event.pointerId);
        } catch {
          // Ignore unsupported pointer capture in edge environments.
        }
      }
      event.preventDefault();
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragIndex === null) return;
    const svg = svgRef.current;
    if (!svg) return;
    const normalized = fromClientPoint(svg, event.clientX, event.clientY);
    commitDragAt(dragIndex, normalized.x, normalized.y);
  };

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragIndex === null) return;
    const svg = svgRef.current;
    if (
      svg &&
      typeof svg.hasPointerCapture === 'function' &&
      svg.hasPointerCapture(event.pointerId)
    ) {
      if (typeof svg.releasePointerCapture === 'function') {
        try {
          svg.releasePointerCapture(event.pointerId);
        } catch {
          // Ignore unsupported pointer release in edge environments.
        }
      }
    }
    setDragIndex(null);
  };

  const handleDoubleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || normalizedPoints.length <= 2) return;
    const graphX =
      ((event.clientX - svg.getBoundingClientRect().left) /
        Math.max(1, svg.getBoundingClientRect().width)) *
      GRAPH_WIDTH;
    const graphY =
      ((event.clientY - svg.getBoundingClientRect().top) /
        Math.max(1, svg.getBoundingClientRect().height)) *
      GRAPH_HEIGHT;
    const nearestIndex = findNearestPointIndex(normalizedPoints, graphX, graphY);
    if (nearestIndex <= 0 || nearestIndex >= normalizedPoints.length - 1) return;

    const next = normalizedPoints.map((point) => ({ ...point }));
    next.splice(nearestIndex, 1);
    onChange(normalizePressureCurvePoints(next));
  };

  return (
    <svg
      ref={svgRef}
      className="pressure-curve-editor"
      viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
      aria-label="Pressure curve editor"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
    >
      <rect
        x={GRAPH_PADDING}
        y={GRAPH_PADDING}
        width={GRAPH_WIDTH - GRAPH_PADDING * 2}
        height={GRAPH_HEIGHT - GRAPH_PADDING * 2}
        className="pressure-curve-editor__bg"
      />
      {[0.25, 0.5, 0.75].map((line) => (
        <g key={line}>
          <line
            x1={toGraphX(line)}
            y1={GRAPH_PADDING}
            x2={toGraphX(line)}
            y2={GRAPH_HEIGHT - GRAPH_PADDING}
            className="pressure-curve-editor__grid"
          />
          <line
            x1={GRAPH_PADDING}
            y1={toGraphY(line)}
            x2={GRAPH_WIDTH - GRAPH_PADDING}
            y2={toGraphY(line)}
            className="pressure-curve-editor__grid"
          />
        </g>
      ))}
      <path d={curvePath} className="pressure-curve-editor__curve" />
      {normalizedPoints.map((point, index) => (
        <circle
          key={`${index}-${point.x.toFixed(4)}-${point.y.toFixed(4)}`}
          cx={toGraphX(point.x)}
          cy={toGraphY(point.y)}
          r={index === 0 || index === normalizedPoints.length - 1 ? 5 : 4.5}
          className="pressure-curve-editor__point"
        />
      ))}
    </svg>
  );
}

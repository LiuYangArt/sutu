import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type {
  AddColorStopOptions,
  AddOpacityStopOptions,
  ColorStop,
  OpacityStop,
} from '@/stores/gradient';
import {
  buildGradientPreviewCss,
  clamp01,
  clampMidpoint,
  resolveStopDisplayColor,
  sampleColorHexAt,
  sampleOpacityAt,
} from './utils';

interface GradientBarProps {
  colorStops: ColorStop[];
  opacityStops: OpacityStop[];
  transparencyEnabled: boolean;
  selectedColorStopId: string | null;
  selectedOpacityStopId: string | null;
  foregroundColor: string;
  backgroundColor: string;
  onSelectColorStop: (id: string) => void;
  onSelectOpacityStop: (id: string) => void;
  onAddColorStop: (position: number, options?: AddColorStopOptions) => void;
  onAddOpacityStop: (position: number, options?: AddOpacityStopOptions) => void;
  onUpdateColorStop: (id: string, patch: Partial<ColorStop>) => void;
  onUpdateOpacityStop: (id: string, patch: Partial<OpacityStop>) => void;
}

type DragState =
  | { kind: 'color-stop'; id: string }
  | { kind: 'opacity-stop'; id: string }
  | { kind: 'color-midpoint'; rightId: string }
  | { kind: 'opacity-midpoint'; rightId: string }
  | null;

interface StopSegment<T extends { id: string; position: number; midpoint: number }> {
  left: T;
  right: T;
}

const PREVIEW_TOP = 20;
const PREVIEW_HEIGHT = 28;
const PREVIEW_BOTTOM = PREVIEW_TOP + PREVIEW_HEIGHT;
const STOP_EPSILON = 0.002;

function readPositionFromEvent(track: HTMLElement, event: PointerEvent): number {
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  const value = (event.clientX - rect.left) / rect.width;
  return clamp01(value);
}

function clampStopPosition<T extends { id: string; position: number }>(
  stops: T[],
  id: string,
  position: number
): number {
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const index = sorted.findIndex((stop) => stop.id === id);
  if (index < 0) return clamp01(position);
  const prev = index > 0 ? sorted[index - 1] : null;
  const next = index < sorted.length - 1 ? sorted[index + 1] : null;
  const min = prev ? prev.position + STOP_EPSILON : 0;
  const max = next ? next.position - STOP_EPSILON : 1;
  if (min > max) return (min + max) * 0.5;
  return Math.min(max, Math.max(min, clamp01(position)));
}

function findSegmentByRightId<T extends { id: string; position: number; midpoint: number }>(
  stops: T[],
  rightId: string
): StopSegment<T> | null {
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const index = sorted.findIndex((stop) => stop.id === rightId);
  if (index <= 0) return null;
  const right = sorted[index];
  const left = sorted[index - 1];
  if (!right || !left) return null;
  return { left, right };
}

export function GradientBar({
  colorStops,
  opacityStops,
  transparencyEnabled,
  selectedColorStopId,
  selectedOpacityStopId,
  foregroundColor,
  backgroundColor,
  onSelectColorStop,
  onSelectOpacityStop,
  onAddColorStop,
  onAddOpacityStop,
  onUpdateColorStop,
  onUpdateOpacityStop,
}: GradientBarProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState>(null);

  const previewCss = useMemo(
    () =>
      buildGradientPreviewCss(
        colorStops,
        opacityStops,
        foregroundColor,
        backgroundColor,
        transparencyEnabled
      ),
    [backgroundColor, colorStops, foregroundColor, opacityStops, transparencyEnabled]
  );

  const colorSegments = useMemo(() => {
    const sorted = [...colorStops].sort((a, b) => a.position - b.position);
    return sorted.slice(1).map((right, index) => {
      const left = sorted[index]!;
      const span = Math.max(1e-6, right.position - left.position);
      const center = left.position + span * clampMidpoint(right.midpoint);
      const active = selectedColorStopId === left.id || selectedColorStopId === right.id;
      return { left, right, center, active };
    });
  }, [colorStops, selectedColorStopId]);

  const opacitySegments = useMemo(() => {
    const sorted = [...opacityStops].sort((a, b) => a.position - b.position);
    return sorted.slice(1).map((right, index) => {
      const left = sorted[index]!;
      const span = Math.max(1e-6, right.position - left.position);
      const center = left.position + span * clampMidpoint(right.midpoint);
      const active = selectedOpacityStopId === left.id || selectedOpacityStopId === right.id;
      return { left, right, center, active };
    });
  }, [opacityStops, selectedOpacityStopId]);

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const strip = stripRef.current;
      if (!strip) return;
      const position = readPositionFromEvent(strip, event);

      if (drag.kind === 'color-stop') {
        const clamped = clampStopPosition(colorStops, drag.id, position);
        onUpdateColorStop(drag.id, { position: clamped });
        return;
      }

      if (drag.kind === 'opacity-stop') {
        const clamped = clampStopPosition(opacityStops, drag.id, position);
        onUpdateOpacityStop(drag.id, { position: clamped });
        return;
      }

      if (drag.kind === 'color-midpoint') {
        const segment = findSegmentByRightId(colorStops, drag.rightId);
        if (!segment) return;
        const span = Math.max(1e-6, segment.right.position - segment.left.position);
        const localT = clamp01((position - segment.left.position) / span);
        onUpdateColorStop(drag.rightId, { midpoint: clampMidpoint(localT) });
        return;
      }

      const segment = findSegmentByRightId(opacityStops, drag.rightId);
      if (!segment) return;
      const span = Math.max(1e-6, segment.right.position - segment.left.position);
      const localT = clamp01((position - segment.left.position) / span);
      onUpdateOpacityStop(drag.rightId, { midpoint: clampMidpoint(localT) });
    },
    [colorStops, onUpdateColorStop, onUpdateOpacityStop, opacityStops]
  );

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  const handleStripPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-gradient-control="true"]')) return;

    const strip = stripRef.current;
    if (!strip) return;
    const rect = strip.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const position = clamp01((event.clientX - rect.left) / rect.width);

    if (y < PREVIEW_TOP) {
      const opacity = sampleOpacityAt(position, opacityStops);
      onAddOpacityStop(position, { opacity, midpoint: 0.5 });
      return;
    }

    if (y > PREVIEW_BOTTOM) {
      const color = sampleColorHexAt(position, colorStops, foregroundColor, backgroundColor);
      onAddColorStop(position, { source: 'fixed', color, midpoint: 0.5 });
    }
  };

  return (
    <div className="gradient-bar-editor">
      <div
        ref={stripRef}
        className="gradient-control-strip"
        onPointerDown={handleStripPointerDown}
        title="Click top to add opacity stop, click bottom to add color stop"
      >
        <div className="gradient-preview-band" style={{ backgroundImage: previewCss }} />

        {opacitySegments
          .filter((segment) => segment.active)
          .map((segment) => {
            const left = `${Math.round(segment.center * 1000) / 10}%`;
            return (
              <button
                key={`opacity-mid-${segment.right.id}`}
                type="button"
                data-gradient-control="true"
                className="gradient-midpoint opacity-midpoint"
                style={{ left }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  dragRef.current = { kind: 'opacity-midpoint', rightId: segment.right.id };
                }}
              />
            );
          })}

        {colorSegments
          .filter((segment) => segment.active)
          .map((segment) => {
            const left = `${Math.round(segment.center * 1000) / 10}%`;
            return (
              <button
                key={`color-mid-${segment.right.id}`}
                type="button"
                data-gradient-control="true"
                className="gradient-midpoint color-midpoint"
                style={{ left }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  dragRef.current = { kind: 'color-midpoint', rightId: segment.right.id };
                }}
              />
            );
          })}

        {opacityStops.map((stop) => {
          const left = `${Math.round(clamp01(stop.position) * 1000) / 10}%`;
          const selected = selectedOpacityStopId === stop.id;
          return (
            <button
              key={stop.id}
              type="button"
              data-gradient-control="true"
              className={`gradient-stop opacity-stop ${selected ? 'selected' : ''}`}
              style={{ left }}
              onPointerDown={(event) => {
                event.preventDefault();
                dragRef.current = { kind: 'opacity-stop', id: stop.id };
                onSelectOpacityStop(stop.id);
              }}
            >
              <span className="stop-label">{Math.round(stop.opacity * 100)}%</span>
            </button>
          );
        })}

        {colorStops.map((stop) => {
          const left = `${Math.round(clamp01(stop.position) * 1000) / 10}%`;
          const selected = selectedColorStopId === stop.id;
          const color = resolveStopDisplayColor(stop, foregroundColor, backgroundColor);
          return (
            <button
              key={stop.id}
              type="button"
              data-gradient-control="true"
              className={`gradient-stop color-stop ${selected ? 'selected' : ''}`}
              style={{ left }}
              onPointerDown={(event) => {
                event.preventDefault();
                dragRef.current = { kind: 'color-stop', id: stop.id };
                onSelectColorStop(stop.id);
              }}
            >
              <span className="stop-color" style={{ backgroundColor: color }} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

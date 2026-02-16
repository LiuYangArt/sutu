import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
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
import { useI18n } from '@/i18n';

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

interface SegmentRenderItem<T> {
  right: T;
  center: number;
  active: boolean;
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

function toPercentPosition(value: number): string {
  return `${Math.round(clamp01(value) * 1000) / 10}%`;
}

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

function buildSegmentRenderItems<T extends { id: string; position: number; midpoint: number }>(
  stops: T[],
  selectedId: string | null
): SegmentRenderItem<T>[] {
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  return sorted.slice(1).map((right, index) => {
    const left = sorted[index]!;
    const span = Math.max(1e-6, right.position - left.position);
    return {
      right,
      center: left.position + span * clampMidpoint(right.midpoint),
      active: selectedId === left.id || selectedId === right.id,
    };
  });
}

function resolveMidpointFromPosition<T extends { id: string; position: number; midpoint: number }>(
  stops: T[],
  rightId: string,
  position: number
): number | null {
  const segment = findSegmentByRightId(stops, rightId);
  if (!segment) return null;
  const span = Math.max(1e-6, segment.right.position - segment.left.position);
  const localT = clamp01((position - segment.left.position) / span);
  return clampMidpoint(localT);
}

function renderMidpointHandles<T extends { id: string }>(
  segments: SegmentRenderItem<T>[],
  className: string,
  keyPrefix: string,
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, rightId: string) => void
): JSX.Element[] {
  return segments
    .filter((segment) => segment.active)
    .map((segment) => (
      <button
        key={`${keyPrefix}-${segment.right.id}`}
        type="button"
        data-gradient-control="true"
        className={`gradient-midpoint ${className}`}
        style={{ left: toPercentPosition(segment.center) }}
        onPointerDown={(event) => onPointerDown(event, segment.right.id)}
      />
    ));
}

function renderStopHandles<T extends { id: string; position: number }>(
  stops: T[],
  selectedId: string | null,
  className: string,
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, stopId: string) => void,
  renderContent: (stop: T) => ReactNode
): JSX.Element[] {
  return stops.map((stop) => (
    <button
      key={stop.id}
      type="button"
      data-gradient-control="true"
      className={`gradient-stop ${className} ${selectedId === stop.id ? 'selected' : ''}`}
      style={{ left: toPercentPosition(stop.position) }}
      onPointerDown={(event) => onPointerDown(event, stop.id)}
    >
      {renderContent(stop)}
    </button>
  ));
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
}: GradientBarProps): JSX.Element {
  const { t } = useI18n();
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState>(null);

  function beginDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    dragState: Exclude<DragState, null>
  ): void {
    event.preventDefault();
    dragRef.current = dragState;
  }

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

  const colorSegments = useMemo(
    () => buildSegmentRenderItems(colorStops, selectedColorStopId),
    [colorStops, selectedColorStopId]
  );

  const opacitySegments = useMemo(
    () => buildSegmentRenderItems(opacityStops, selectedOpacityStopId),
    [opacityStops, selectedOpacityStopId]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const strip = stripRef.current;
      if (!strip) return;
      const position = readPositionFromEvent(strip, event);

      switch (drag.kind) {
        case 'color-stop': {
          const clamped = clampStopPosition(colorStops, drag.id, position);
          onUpdateColorStop(drag.id, { position: clamped });
          return;
        }
        case 'opacity-stop': {
          const clamped = clampStopPosition(opacityStops, drag.id, position);
          onUpdateOpacityStop(drag.id, { position: clamped });
          return;
        }
        case 'color-midpoint': {
          const midpoint = resolveMidpointFromPosition(colorStops, drag.rightId, position);
          if (midpoint === null) return;
          onUpdateColorStop(drag.rightId, { midpoint });
          return;
        }
        case 'opacity-midpoint': {
          const midpoint = resolveMidpointFromPosition(opacityStops, drag.rightId, position);
          if (midpoint === null) return;
          onUpdateOpacityStop(drag.rightId, { midpoint });
          return;
        }
      }
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
        title={t('gradientEditor.addStopHint')}
      >
        <div className="gradient-preview-band" style={{ backgroundImage: previewCss }} />

        {renderMidpointHandles(
          opacitySegments,
          'opacity-midpoint',
          'opacity-mid',
          (event, rightId) => beginDrag(event, { kind: 'opacity-midpoint', rightId })
        )}

        {renderMidpointHandles(colorSegments, 'color-midpoint', 'color-mid', (event, rightId) =>
          beginDrag(event, { kind: 'color-midpoint', rightId })
        )}

        {renderStopHandles(
          opacityStops,
          selectedOpacityStopId,
          'opacity-stop',
          (event, stopId) => {
            beginDrag(event, { kind: 'opacity-stop', id: stopId });
            onSelectOpacityStop(stopId);
          },
          (stop) => (
            <span className="stop-label">{Math.round(stop.opacity * 100)}%</span>
          )
        )}

        {renderStopHandles(
          colorStops,
          selectedColorStopId,
          'color-stop',
          (event, stopId) => {
            beginDrag(event, { kind: 'color-stop', id: stopId });
            onSelectColorStop(stopId);
          },
          (stop) => (
            <span
              className="stop-color"
              style={{
                backgroundColor: resolveStopDisplayColor(stop, foregroundColor, backgroundColor),
              }}
            />
          )
        )}
      </div>
    </div>
  );
}

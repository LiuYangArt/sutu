import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ColorStop, OpacityStop } from '@/stores/gradient';
import { buildGradientPreviewCss, clamp01, resolveStopDisplayColor } from './utils';

interface GradientBarProps {
  colorStops: ColorStop[];
  opacityStops: OpacityStop[];
  selectedColorStopId: string | null;
  selectedOpacityStopId: string | null;
  foregroundColor: string;
  backgroundColor: string;
  onSelectColorStop: (id: string) => void;
  onSelectOpacityStop: (id: string) => void;
  onAddColorStop: (position: number) => void;
  onAddOpacityStop: (position: number) => void;
  onUpdateColorStopPosition: (id: string, position: number) => void;
  onUpdateOpacityStopPosition: (id: string, position: number) => void;
  onRemoveColorStop: (id: string) => void;
  onRemoveOpacityStop: (id: string) => void;
}

type DragState = { kind: 'color'; id: string } | { kind: 'opacity'; id: string } | null;

function readPositionFromEvent(track: HTMLElement, event: PointerEvent): number {
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  const value = (event.clientX - rect.left) / rect.width;
  return clamp01(value);
}

export function GradientBar({
  colorStops,
  opacityStops,
  selectedColorStopId,
  selectedOpacityStopId,
  foregroundColor,
  backgroundColor,
  onSelectColorStop,
  onSelectOpacityStop,
  onAddColorStop,
  onAddOpacityStop,
  onUpdateColorStopPosition,
  onUpdateOpacityStopPosition,
  onRemoveColorStop,
  onRemoveOpacityStop,
}: GradientBarProps) {
  const colorTrackRef = useRef<HTMLDivElement | null>(null);
  const opacityTrackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState>(null);

  const previewCss = useMemo(
    () => buildGradientPreviewCss(colorStops, foregroundColor, backgroundColor),
    [backgroundColor, colorStops, foregroundColor]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      if (drag.kind === 'color') {
        const track = colorTrackRef.current;
        if (!track) return;
        const position = readPositionFromEvent(track, event);
        onUpdateColorStopPosition(drag.id, position);
        return;
      }

      const track = opacityTrackRef.current;
      if (!track) return;
      const position = readPositionFromEvent(track, event);
      onUpdateOpacityStopPosition(drag.id, position);
    },
    [onUpdateColorStopPosition, onUpdateOpacityStopPosition]
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

  return (
    <div className="gradient-bar-editor">
      <div className="gradient-preview" style={{ backgroundImage: previewCss }} />

      <div
        ref={opacityTrackRef}
        className="gradient-stop-track opacity-track"
        onDoubleClick={(event) => {
          const target = event.currentTarget;
          const rect = target.getBoundingClientRect();
          const position = clamp01((event.clientX - rect.left) / rect.width);
          onAddOpacityStop(position);
        }}
      >
        {opacityStops.map((stop) => {
          const left = `${Math.round(clamp01(stop.position) * 1000) / 10}%`;
          const selected = selectedOpacityStopId === stop.id;
          return (
            <button
              key={stop.id}
              className={`gradient-stop opacity-stop ${selected ? 'selected' : ''}`}
              style={{ left }}
              onPointerDown={(event) => {
                event.preventDefault();
                dragRef.current = { kind: 'opacity', id: stop.id };
                onSelectOpacityStop(stop.id);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onRemoveOpacityStop(stop.id);
              }}
            >
              <span className="stop-label">{Math.round(stop.opacity * 100)}%</span>
            </button>
          );
        })}
      </div>

      <div
        ref={colorTrackRef}
        className="gradient-stop-track color-track"
        onDoubleClick={(event) => {
          const target = event.currentTarget;
          const rect = target.getBoundingClientRect();
          const position = clamp01((event.clientX - rect.left) / rect.width);
          onAddColorStop(position);
        }}
      >
        {colorStops.map((stop) => {
          const left = `${Math.round(clamp01(stop.position) * 1000) / 10}%`;
          const selected = selectedColorStopId === stop.id;
          const color = resolveStopDisplayColor(stop, foregroundColor, backgroundColor);
          return (
            <button
              key={stop.id}
              className={`gradient-stop color-stop ${selected ? 'selected' : ''}`}
              style={{ left }}
              onPointerDown={(event) => {
                event.preventDefault();
                dragRef.current = { kind: 'color', id: stop.id };
                onSelectColorStop(stop.id);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onRemoveColorStop(stop.id);
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

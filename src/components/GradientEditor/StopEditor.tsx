import type { ColorStop, OpacityStop } from '@/stores/gradient';
import { clamp01, resolveStopDisplayColor } from './utils';

interface StopEditorProps {
  colorStop: ColorStop | null;
  opacityStop: OpacityStop | null;
  colorStopCount: number;
  opacityStopCount: number;
  foregroundColor: string;
  backgroundColor: string;
  onUpdateColorStop: (id: string, patch: Partial<ColorStop>) => void;
  onRemoveColorStop: (id: string) => void;
  onUpdateOpacityStop: (id: string, patch: Partial<OpacityStop>) => void;
  onRemoveOpacityStop: (id: string) => void;
}

function toPercent(value: number): number {
  return Math.round(clamp01(value) * 100);
}

function fromPercent(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp01(parsed / 100);
}

export function StopEditor({
  colorStop,
  opacityStop,
  colorStopCount,
  opacityStopCount,
  foregroundColor,
  backgroundColor,
  onUpdateColorStop,
  onRemoveColorStop,
  onUpdateOpacityStop,
  onRemoveOpacityStop,
}: StopEditorProps) {
  return (
    <section className="gradient-stop-editor">
      <h4>Stops</h4>

      {opacityStop && (
        <div className="stop-editor-grid">
          <span className="stop-editor-label">Opacity</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={toPercent(opacityStop.opacity)}
            onChange={(event) =>
              onUpdateOpacityStop(opacityStop.id, {
                opacity: fromPercent(event.target.value, opacityStop.opacity),
              })
            }
          />
          <span className="stop-editor-label">Location</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={toPercent(opacityStop.position)}
            onChange={(event) =>
              onUpdateOpacityStop(opacityStop.id, {
                position: fromPercent(event.target.value, opacityStop.position),
              })
            }
          />
          <button
            type="button"
            className="stop-delete-btn"
            disabled={opacityStopCount <= 2}
            onClick={() => onRemoveOpacityStop(opacityStop.id)}
          >
            Delete
          </button>
        </div>
      )}

      {colorStop && (
        <div className="stop-editor-grid">
          <span className="stop-editor-label">Source</span>
          <select
            value={colorStop.source}
            onChange={(event) =>
              onUpdateColorStop(colorStop.id, {
                source: event.target.value as ColorStop['source'],
              })
            }
          >
            <option value="fixed">Fixed Color</option>
            <option value="foreground">Foreground</option>
            <option value="background">Background</option>
          </select>
          <span className="stop-editor-label">Location</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={toPercent(colorStop.position)}
            onChange={(event) =>
              onUpdateColorStop(colorStop.id, {
                position: fromPercent(event.target.value, colorStop.position),
              })
            }
          />
          <span className="stop-editor-label">Color</span>
          <input
            type="color"
            disabled={colorStop.source !== 'fixed'}
            value={resolveStopDisplayColor(colorStop, foregroundColor, backgroundColor)}
            onChange={(event) =>
              onUpdateColorStop(colorStop.id, {
                color: event.target.value,
                source: 'fixed',
              })
            }
          />
          <button
            type="button"
            className="stop-delete-btn"
            disabled={colorStopCount <= 2}
            onClick={() => onRemoveColorStop(colorStop.id)}
          >
            Delete
          </button>
        </div>
      )}

      {!colorStop && !opacityStop && <p className="empty-hint">Select a stop to edit details.</p>}
    </section>
  );
}

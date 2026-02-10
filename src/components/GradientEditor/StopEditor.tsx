import type { ColorStop, OpacityStop } from '@/stores/gradient';
import { clamp01, resolveStopDisplayColor } from './utils';

interface StopEditorProps {
  colorStop: ColorStop | null;
  opacityStop: OpacityStop | null;
  foregroundColor: string;
  backgroundColor: string;
  onUpdateColorStop: (id: string, patch: Partial<ColorStop>) => void;
  onRemoveColorStop: (id: string) => void;
  onUpdateOpacityStop: (id: string, patch: Partial<OpacityStop>) => void;
  onRemoveOpacityStop: (id: string) => void;
}

export function StopEditor({
  colorStop,
  opacityStop,
  foregroundColor,
  backgroundColor,
  onUpdateColorStop,
  onRemoveColorStop,
  onUpdateOpacityStop,
  onRemoveOpacityStop,
}: StopEditorProps) {
  return (
    <section className="gradient-stop-editor">
      <h4>Selected Stop</h4>
      {colorStop && (
        <div className="stop-editor-block">
          <div className="stop-editor-row">
            <span>Color Stop</span>
            <button className="danger" onClick={() => onRemoveColorStop(colorStop.id)}>
              Delete
            </button>
          </div>
          <label>
            Source
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
          </label>

          <label>
            Position
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={clamp01(colorStop.position)}
              onChange={(event) =>
                onUpdateColorStop(colorStop.id, {
                  position: Number(event.target.value),
                })
              }
            />
          </label>

          <label>
            Color
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
          </label>
        </div>
      )}

      {opacityStop && (
        <div className="stop-editor-block">
          <div className="stop-editor-row">
            <span>Opacity Stop</span>
            <button className="danger" onClick={() => onRemoveOpacityStop(opacityStop.id)}>
              Delete
            </button>
          </div>
          <label>
            Position
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={clamp01(opacityStop.position)}
              onChange={(event) =>
                onUpdateOpacityStop(opacityStop.id, {
                  position: Number(event.target.value),
                })
              }
            />
          </label>

          <label>
            Opacity
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={clamp01(opacityStop.opacity)}
              onChange={(event) =>
                onUpdateOpacityStop(opacityStop.id, {
                  opacity: Number(event.target.value),
                })
              }
            />
            <span className="stop-value">{Math.round(clamp01(opacityStop.opacity) * 100)}%</span>
          </label>
        </div>
      )}

      {!colorStop && !opacityStop && (
        <p className="empty-hint">Select a stop to edit its details.</p>
      )}
    </section>
  );
}

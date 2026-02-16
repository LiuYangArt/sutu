import type { ColorStop, OpacityStop } from '@/stores/gradient';
import { clamp01, resolveStopDisplayColor } from './utils';
import { useI18n } from '@/i18n';

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

function parsePercent(value: string, fallback: number): number {
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
}: StopEditorProps): JSX.Element {
  const { t } = useI18n();
  const canDeleteOpacityStop = opacityStopCount > 2;
  const canDeleteColorStop = colorStopCount > 2;

  function updateOpacity(value: string): void {
    if (!opacityStop) return;
    onUpdateOpacityStop(opacityStop.id, {
      opacity: parsePercent(value, opacityStop.opacity),
    });
  }

  function updateOpacityLocation(value: string): void {
    if (!opacityStop) return;
    onUpdateOpacityStop(opacityStop.id, {
      position: parsePercent(value, opacityStop.position),
    });
  }

  function updateColorSource(value: string): void {
    if (!colorStop) return;
    onUpdateColorStop(colorStop.id, {
      source: value as ColorStop['source'],
    });
  }

  function updateColorLocation(value: string): void {
    if (!colorStop) return;
    onUpdateColorStop(colorStop.id, {
      position: parsePercent(value, colorStop.position),
    });
  }

  function updateFixedColor(value: string): void {
    if (!colorStop) return;
    onUpdateColorStop(colorStop.id, {
      color: value,
      source: 'fixed',
    });
  }

  return (
    <section className="gradient-stop-editor">
      <h4>{t('gradientEditor.stops')}</h4>

      {opacityStop && (
        <div className="stop-editor-grid opacity-grid">
          <span className="stop-editor-label">{t('gradientEditor.opacity')}</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={toPercent(opacityStop.opacity)}
            onChange={(event) => updateOpacity(event.target.value)}
          />
          <span className="stop-editor-label">{t('gradientEditor.location')}</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={toPercent(opacityStop.position)}
            onChange={(event) => updateOpacityLocation(event.target.value)}
          />
          <button
            type="button"
            className="stop-delete-btn"
            disabled={!canDeleteOpacityStop}
            onClick={() => onRemoveOpacityStop(opacityStop.id)}
          >
            {t('gradientEditor.delete')}
          </button>
        </div>
      )}

      {colorStop && (
        <div className="stop-editor-grid color-grid">
          <span className="stop-editor-label">{t('gradientEditor.source')}</span>
          <select
            value={colorStop.source}
            onChange={(event) => updateColorSource(event.target.value)}
          >
            <option value="fixed">{t('gradientEditor.sourceFixedColor')}</option>
            <option value="foreground">{t('gradientEditor.sourceForeground')}</option>
            <option value="background">{t('gradientEditor.sourceBackground')}</option>
          </select>
          <span className="stop-editor-label">{t('gradientEditor.location')}</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={toPercent(colorStop.position)}
            onChange={(event) => updateColorLocation(event.target.value)}
          />
          <span className="stop-editor-label">{t('gradientEditor.color')}</span>
          <input
            type="color"
            disabled={colorStop.source !== 'fixed'}
            value={resolveStopDisplayColor(colorStop, foregroundColor, backgroundColor)}
            onChange={(event) => updateFixedColor(event.target.value)}
          />
          <button
            type="button"
            className="stop-delete-btn"
            disabled={!canDeleteColorStop}
            onClick={() => onRemoveColorStop(colorStop.id)}
          >
            {t('gradientEditor.delete')}
          </button>
        </div>
      )}

      {!colorStop && !opacityStop && (
        <p className="empty-hint">{t('gradientEditor.selectStopToEditDetails')}</p>
      )}
    </section>
  );
}

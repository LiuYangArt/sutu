import type { GradientPreset } from '@/stores/gradient';
import { buildGradientPreviewCss } from './utils';
import { useI18n } from '@/i18n';
import { getGradientPresetDisplayName } from './presetI18n';

interface PresetGridProps {
  presets: GradientPreset[];
  activePresetId: string | null;
  foregroundColor: string;
  backgroundColor: string;
  onActivate: (id: string) => void;
  onCopyToCustom: (id: string) => void;
  onSaveCustom: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}

function buildPresetPreview(
  preset: GradientPreset,
  foregroundColor: string,
  backgroundColor: string
): string {
  return buildGradientPreviewCss(
    preset.colorStops,
    preset.opacityStops,
    foregroundColor,
    backgroundColor,
    true
  );
}

export function PresetGrid({
  presets,
  activePresetId,
  foregroundColor,
  backgroundColor,
  onActivate,
  onCopyToCustom,
  onSaveCustom,
  onRename,
  onDelete,
}: PresetGridProps): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="gradient-presets">
      <div className="gradient-presets-header">
        <h4>{t('gradientEditor.presets')}</h4>
        <button type="button" className="gradient-preset-btn primary" onClick={onSaveCustom}>
          {t('gradientEditor.saveCurrent')}
        </button>
      </div>

      <div className="gradient-preset-list">
        {presets.map((preset) => {
          const active = preset.id === activePresetId;
          const displayName = getGradientPresetDisplayName(preset, t);
          const preview = buildPresetPreview(preset, foregroundColor, backgroundColor);

          return (
            <div key={preset.id} className={`gradient-preset-item ${active ? 'active' : ''}`}>
              <button
                type="button"
                className="gradient-preset-preview"
                style={{ backgroundImage: preview }}
                title={displayName}
                onClick={() => onActivate(preset.id)}
                onDoubleClick={() => onCopyToCustom(preset.id)}
              />
              <div className="gradient-preset-meta">
                <span className="gradient-preset-name">{displayName}</span>
                <div className="gradient-preset-actions">
                  <button
                    type="button"
                    className="gradient-preset-btn"
                    onClick={() => onCopyToCustom(preset.id)}
                  >
                    {t('gradientEditor.use')}
                  </button>
                  <button
                    type="button"
                    className="gradient-preset-btn"
                    onClick={() => onRename(preset.id)}
                  >
                    {t('gradientEditor.rename')}
                  </button>
                  <button
                    type="button"
                    className="gradient-preset-btn danger"
                    onClick={() => onDelete(preset.id)}
                  >
                    {t('gradientEditor.delete')}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

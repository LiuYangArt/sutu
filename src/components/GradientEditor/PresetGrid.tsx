import type { GradientPreset } from '@/stores/gradient';
import { buildGradientPreviewCss } from './utils';

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
}: PresetGridProps) {
  return (
    <section className="gradient-presets">
      <div className="gradient-presets-header">
        <h4>Presets</h4>
        <button onClick={onSaveCustom}>Save Current</button>
      </div>

      <div className="gradient-preset-grid">
        {presets.map((preset) => {
          const active = preset.id === activePresetId;
          const preview = buildGradientPreviewCss(
            preset.colorStops,
            foregroundColor,
            backgroundColor
          );
          return (
            <div key={preset.id} className={`gradient-preset-card ${active ? 'active' : ''}`}>
              <button
                className="gradient-preset-preview"
                style={{ backgroundImage: preview }}
                title={preset.name}
                onClick={() => onActivate(preset.id)}
                onDoubleClick={() => onCopyToCustom(preset.id)}
              />
              <div className="gradient-preset-meta">
                <span>{preset.name}</span>
                <div className="gradient-preset-actions">
                  <button onClick={() => onCopyToCustom(preset.id)}>Use</button>
                  <button onClick={() => onRename(preset.id)}>Rename</button>
                  <button className="danger" onClick={() => onDelete(preset.id)}>
                    Delete
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

import { PaintBucket } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings';
import { useI18n } from '@/i18n';

const ICON_PROPS = { size: 18, strokeWidth: 1.5 } as const;

export function SelectionToolbar() {
  const { t } = useI18n();
  const autoFillEnabled = useSettingsStore((s) => s.general.selectionAutoFillEnabled);
  const previewTranslucent = useSettingsStore((s) => s.general.selectionPreviewTranslucent);
  const setAutoFillEnabled = useSettingsStore((s) => s.setSelectionAutoFillEnabled);
  const setPreviewTranslucent = useSettingsStore((s) => s.setSelectionPreviewTranslucent);
  const previewToggleDisabled = !autoFillEnabled;
  const previewToggleTitle = previewTranslucent
    ? t('toolbar.selection.translucentPreviewOn')
    : t('toolbar.selection.translucentPreviewOff');

  function handleToggleAutoFill(): void {
    setAutoFillEnabled(!autoFillEnabled);
  }

  function handleTogglePreviewTranslucent(): void {
    setPreviewTranslucent(!previewTranslucent);
  }

  return (
    <div className="selection-toolbar">
      <button
        type="button"
        className={`tool-option-btn selection-auto-fill-btn ${autoFillEnabled ? 'active' : ''}`}
        onClick={handleToggleAutoFill}
        title={t('toolbar.selection.autoFillSelection')}
        aria-label={t('toolbar.selection.autoFillSelection')}
        aria-pressed={autoFillEnabled}
      >
        <PaintBucket {...ICON_PROPS} />
      </button>
      <button
        type="button"
        className={`tool-option-btn selection-preview-toggle-btn ${
          previewTranslucent ? 'active' : ''
        }`}
        onClick={handleTogglePreviewTranslucent}
        title={previewToggleTitle}
        aria-label={t('toolbar.selection.translucentPreview')}
        aria-pressed={previewTranslucent}
        disabled={previewToggleDisabled}
      >
        <span className="selection-preview-toggle-label">
          {t('toolbar.selection.translucentPreview')}
        </span>
      </button>
    </div>
  );
}

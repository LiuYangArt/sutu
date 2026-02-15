import { PaintBucket } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings';

const ICON_PROPS = { size: 16, strokeWidth: 1.75 } as const;

export function SelectionToolbar() {
  const autoFillEnabled = useSettingsStore((s) => s.general.selectionAutoFillEnabled);
  const previewTranslucent = useSettingsStore((s) => s.general.selectionPreviewTranslucent);
  const setAutoFillEnabled = useSettingsStore((s) => s.setSelectionAutoFillEnabled);
  const setPreviewTranslucent = useSettingsStore((s) => s.setSelectionPreviewTranslucent);
  const previewToggleDisabled = !autoFillEnabled;
  const previewToggleTitle = previewTranslucent
    ? 'Translucent Preview: On'
    : 'Translucent Preview: Off';

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
        title="Auto Fill Selection"
        aria-label="Auto Fill Selection"
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
        aria-label="Translucent Preview"
        aria-pressed={previewTranslucent}
        disabled={previewToggleDisabled}
      >
        <span className="selection-preview-toggle-label">Translucent Preview</span>
      </button>
    </div>
  );
}

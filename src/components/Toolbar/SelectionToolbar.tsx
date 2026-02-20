import { CircleDashed, PaintBucket, SquareDashed } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings';
import { useToolStore } from '@/stores/tool';
import { useSelectionStore } from '@/stores/selection';
import { useI18n } from '@/i18n';

const SHAPE_ICON_PROPS = { size: 20, strokeWidth: 1.75 } as const;
const ACTION_ICON_PROPS = { size: 19, strokeWidth: 1.6 } as const;

export function SelectionToolbar() {
  const { t } = useI18n();
  const currentTool = useToolStore((s) => s.currentTool);
  const selectionShape = useSelectionStore((s) => s.selectionShape);
  const setSelectionShape = useSelectionStore((s) => s.setSelectionShape);
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
      {currentTool === 'select' && (
        <div
          className="selection-shape-toggle"
          role="group"
          aria-label={t('toolbar.selection.shapeGroup')}
        >
          <button
            type="button"
            className={`tool-option-btn selection-shape-btn ${selectionShape === 'rect' ? 'active' : ''}`}
            onClick={() => setSelectionShape('rect')}
            title={t('toolbar.selection.shapeRect')}
            aria-label={t('toolbar.selection.shapeRect')}
            aria-pressed={selectionShape === 'rect'}
          >
            <SquareDashed {...SHAPE_ICON_PROPS} />
          </button>
          <button
            type="button"
            className={`tool-option-btn selection-shape-btn ${selectionShape === 'circle' ? 'active' : ''}`}
            onClick={() => setSelectionShape('circle')}
            title={t('toolbar.selection.shapeCircle')}
            aria-label={t('toolbar.selection.shapeCircle')}
            aria-pressed={selectionShape === 'circle'}
          >
            <CircleDashed {...SHAPE_ICON_PROPS} />
          </button>
        </div>
      )}
      <button
        type="button"
        className={`tool-option-btn selection-auto-fill-btn ${autoFillEnabled ? 'active' : ''}`}
        onClick={handleToggleAutoFill}
        title={t('toolbar.selection.autoFillSelection')}
        aria-label={t('toolbar.selection.autoFillSelection')}
        aria-pressed={autoFillEnabled}
      >
        <PaintBucket {...ACTION_ICON_PROPS} />
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

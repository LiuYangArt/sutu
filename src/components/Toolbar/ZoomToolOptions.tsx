import { useViewportStore } from '@/stores/viewport';
import { useDocumentStore } from '@/stores/document';
import { useI18n } from '@/i18n';

export function ZoomToolOptions() {
  const { t } = useI18n();
  const { zoomToFit, resetZoom } = useViewportStore();
  const { width, height } = useDocumentStore();

  const handleFit = () => {
    const container = document.querySelector('.canvas-container');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    zoomToFit(width, height, rect.width, rect.height);
  };

  return (
    <div className="zoom-tool-options">
      <button className="tool-option-btn" onClick={handleFit} title={t('toolbar.zoom.fitToWindow')}>
        {t('toolbar.zoom.fit')}
      </button>
      <button
        className="tool-option-btn"
        onClick={resetZoom}
        title={t('toolbar.zoom.actualPixels')}
      >
        100%
      </button>
    </div>
  );
}

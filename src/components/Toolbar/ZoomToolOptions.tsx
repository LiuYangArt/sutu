import { useViewportStore } from '@/stores/viewport';
import { useDocumentStore } from '@/stores/document';

export function ZoomToolOptions() {
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
      <button className="tool-option-btn" onClick={handleFit} title="Fit to window">
        Fit
      </button>
      <button className="tool-option-btn" onClick={resetZoom} title="Actual pixels (100%)">
        100%
      </button>
    </div>
  );
}

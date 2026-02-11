import { X } from 'lucide-react';
import { usePanelStore } from '@/stores/panel';
import { GradientEditor } from './index';

export function GradientEditorModal(): JSX.Element | null {
  const isOpen = usePanelStore((s) => s.panels['gradient-panel']?.isOpen ?? false);
  const closePanel = usePanelStore((s) => s.closePanel);

  if (!isOpen) return null;

  return (
    <div className="gradient-editor-overlay" onClick={() => closePanel('gradient-panel')}>
      <div
        className="gradient-editor-modal mica-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="gradient-editor-modal-header mica-panel-header">
          <h2>Gradient Editor</h2>
          <button
            type="button"
            className="gradient-editor-close-btn"
            onClick={() => closePanel('gradient-panel')}
            aria-label="Close Gradient Editor"
          >
            <X size={18} />
          </button>
        </div>
        <div className="gradient-editor-modal-content">
          <GradientEditor />
        </div>
      </div>
    </div>
  );
}

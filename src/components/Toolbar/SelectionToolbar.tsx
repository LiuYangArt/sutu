import { PaintBucket } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings';

const ICON_PROPS = { size: 16, strokeWidth: 1.75 } as const;

export function SelectionToolbar() {
  const enabled = useSettingsStore((s) => s.general.selectionAutoFillEnabled);
  const setEnabled = useSettingsStore((s) => s.setSelectionAutoFillEnabled);

  return (
    <div className="selection-toolbar">
      <button
        type="button"
        className={`tool-option-btn selection-auto-fill-btn ${enabled ? 'active' : ''}`}
        onClick={() => setEnabled(!enabled)}
        title="Auto Fill Selection"
        aria-label="Auto Fill Selection"
        aria-pressed={enabled}
      >
        <PaintBucket {...ICON_PROPS} />
      </button>
    </div>
  );
}

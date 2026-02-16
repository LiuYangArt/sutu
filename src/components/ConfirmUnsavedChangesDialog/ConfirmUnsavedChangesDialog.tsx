import { useState } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '@/i18n';
import './ConfirmUnsavedChangesDialog.css';

interface ConfirmUnsavedChangesDialogProps {
  isOpen: boolean;
  onSave: () => Promise<void>;
  onDontSave: () => void;
  onCancel: () => void;
}

export function ConfirmUnsavedChangesDialog({
  isOpen,
  onSave,
  onDontSave,
  onCancel,
}: ConfirmUnsavedChangesDialogProps): JSX.Element | null {
  const { t } = useI18n();
  const [isSaving, setIsSaving] = useState(false);

  if (!isOpen) return null;

  async function handleSave(): Promise<void> {
    if (isSaving) return;
    setIsSaving(true);
    try {
      await onSave();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="confirm-unsaved-overlay">
      <div className="confirm-unsaved-panel mica-panel" onClick={(e) => e.stopPropagation()}>
        <div className="mica-panel-header confirm-unsaved-header">
          <h2>{t('confirmUnsaved.title')}</h2>
          <button
            className="confirm-unsaved-close-btn"
            onClick={onCancel}
            title={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="confirm-unsaved-body">
          <div className="confirm-unsaved-text">{t('confirmUnsaved.message')}</div>

          <div className="confirm-unsaved-actions">
            <button
              className="confirm-unsaved-btn"
              onClick={onCancel}
              type="button"
              disabled={isSaving}
            >
              {t('common.cancel')}
            </button>
            <button
              className="confirm-unsaved-btn danger"
              onClick={onDontSave}
              type="button"
              disabled={isSaving}
            >
              {t('confirmUnsaved.dontSave')}
            </button>
            <button
              className="confirm-unsaved-btn primary"
              onClick={handleSave}
              type="button"
              disabled={isSaving}
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import './NewFilePanel.css';

export type BackgroundPreset = 'transparent' | 'white' | 'black' | 'current-bg';

interface NewFilePanelProps {
  isOpen: boolean;
  onClose: () => void;
  defaultValues: { width: number; height: number; dpi: number };
  onCreate: (v: {
    width: number;
    height: number;
    dpi: number;
    backgroundPreset: BackgroundPreset;
  }) => void;
}

function parsePositiveInt(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function NewFilePanel({
  isOpen,
  onClose,
  defaultValues,
  onCreate,
}: NewFilePanelProps): JSX.Element | null {
  const [width, setWidth] = useState(String(defaultValues.width));
  const [height, setHeight] = useState(String(defaultValues.height));
  const [dpi, setDpi] = useState(String(defaultValues.dpi));
  const [backgroundPreset, setBackgroundPreset] = useState<BackgroundPreset>('white');

  useEffect(() => {
    if (!isOpen) return;
    setWidth(String(defaultValues.width));
    setHeight(String(defaultValues.height));
    setDpi(String(defaultValues.dpi));
    setBackgroundPreset('white');
  }, [isOpen, defaultValues.width, defaultValues.height, defaultValues.dpi]);

  const parsedWidth = parsePositiveInt(width);
  const parsedHeight = parsePositiveInt(height);
  const parsedDpi = parsePositiveInt(dpi);

  const canCreate = parsedWidth !== null && parsedHeight !== null && parsedDpi !== null;

  function handleCreate(): void {
    if (parsedWidth === null || parsedHeight === null || parsedDpi === null) return;
    onCreate({ width: parsedWidth, height: parsedHeight, dpi: parsedDpi, backgroundPreset });
  }

  if (!isOpen) return null;

  return (
    <div className="new-file-overlay">
      <div className="new-file-panel mica-panel" onClick={(e) => e.stopPropagation()}>
        <div className="mica-panel-header new-file-header">
          <h2>New Document</h2>
          <button className="new-file-close-btn" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="new-file-body">
          <div className="new-file-row">
            <div className="new-file-field">
              <label>Width</label>
              <input
                type="number"
                min={1}
                step={1}
                value={width}
                onChange={(e) => setWidth(e.target.value)}
              />
            </div>
            <div className="new-file-field">
              <label>Height</label>
              <input
                type="number"
                min={1}
                step={1}
                value={height}
                onChange={(e) => setHeight(e.target.value)}
              />
            </div>
          </div>

          <div className="new-file-row">
            <div className="new-file-field">
              <label>Resolution</label>
              <input
                type="number"
                min={1}
                step={1}
                value={dpi}
                onChange={(e) => setDpi(e.target.value)}
              />
              <div className="new-file-hint">dpi</div>
            </div>
          </div>

          <div className="new-file-row">
            <div className="new-file-field">
              <label>Background Contents</label>
              <select
                className="new-file-select"
                value={backgroundPreset}
                onChange={(e) => setBackgroundPreset(e.target.value as BackgroundPreset)}
              >
                <option value="transparent">Transparent</option>
                <option value="white">White</option>
                <option value="black">Black</option>
                <option value="current-bg">Current Background</option>
              </select>
            </div>
          </div>

          <div className="new-file-actions">
            <button className="new-file-btn" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="new-file-btn primary"
              onClick={handleCreate}
              disabled={!canCreate}
              type="button"
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

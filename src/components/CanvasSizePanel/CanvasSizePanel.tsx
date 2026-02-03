import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Link2, Unlink2 } from 'lucide-react';
import { useDocumentStore, type ResizeCanvasOptions } from '@/stores/document';
import { useToolStore } from '@/stores/tool';
import './CanvasSizePanel.css';

type ExtensionPreset = 'transparent' | 'white' | 'black' | 'current-bg';
type LastEditedField = 'width' | 'height';

function parsePositiveInt(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function getAnchorLabel(anchor: ResizeCanvasOptions['anchor']): string {
  switch (anchor) {
    case 'top-left':
      return '↖';
    case 'top':
      return '↑';
    case 'top-right':
      return '↗';
    case 'left':
      return '←';
    case 'center':
      return '•';
    case 'right':
      return '→';
    case 'bottom-left':
      return '↙';
    case 'bottom':
      return '↓';
    case 'bottom-right':
      return '↘';
  }
}

function resolveExtensionColor(preset: ExtensionPreset, backgroundColor: string): string {
  switch (preset) {
    case 'transparent':
      return 'transparent';
    case 'white':
      return '#ffffff';
    case 'black':
      return '#000000';
    case 'current-bg':
      return backgroundColor;
  }
}

interface CanvasSizePanelProps {
  isOpen: boolean;
  onClose: () => void;
  onApply: (options: ResizeCanvasOptions) => void;
}

export function CanvasSizePanel({
  isOpen,
  onClose,
  onApply,
}: CanvasSizePanelProps): JSX.Element | null {
  const { width: currentWidth, height: currentHeight } = useDocumentStore((s) => ({
    width: s.width,
    height: s.height,
  }));
  const backgroundColor = useToolStore((s) => s.backgroundColor);

  const [newWidth, setNewWidth] = useState(String(currentWidth));
  const [newHeight, setNewHeight] = useState(String(currentHeight));
  const [keepAspectRatio, setKeepAspectRatio] = useState(true);
  const [scaleContent, setScaleContent] = useState(false);
  const [anchor, setAnchor] = useState<ResizeCanvasOptions['anchor']>('center');
  const [extensionPreset, setExtensionPreset] = useState<ExtensionPreset>('transparent');
  const [resampleMode, setResampleMode] = useState<ResizeCanvasOptions['resampleMode']>('bicubic');

  const aspectRatioRef = useRef(currentWidth / currentHeight);
  const lastEditedRef = useRef<LastEditedField>('width');

  useEffect(() => {
    if (!isOpen) return;
    setNewWidth(String(currentWidth));
    setNewHeight(String(currentHeight));
    setKeepAspectRatio(true);
    setScaleContent(false);
    setAnchor('center');
    setExtensionPreset('transparent');
    setResampleMode('bicubic');
    aspectRatioRef.current = currentWidth / currentHeight;
    lastEditedRef.current = 'width';
  }, [isOpen, currentWidth, currentHeight]);

  const parsedSize = useMemo(() => {
    return {
      width: parsePositiveInt(newWidth),
      height: parsePositiveInt(newHeight),
    };
  }, [newWidth, newHeight]);

  const canApply = parsedSize.width !== null && parsedSize.height !== null;

  const updateAspectRatioFromCurrentInputs = () => {
    const w = parsedSize.width;
    const h = parsedSize.height;
    if (w && h) {
      aspectRatioRef.current = w / h;
    } else {
      aspectRatioRef.current = currentWidth / currentHeight;
    }
  };

  const handleToggleKeepAspectRatio = () => {
    const next = !keepAspectRatio;
    setKeepAspectRatio(next);
    if (next) {
      updateAspectRatioFromCurrentInputs();
      const w = parsedSize.width;
      const h = parsedSize.height;
      if (w && aspectRatioRef.current > 0) {
        if (lastEditedRef.current === 'width') {
          setNewHeight(String(Math.max(1, Math.round(w / aspectRatioRef.current))));
        } else if (h) {
          setNewWidth(String(Math.max(1, Math.round(h * aspectRatioRef.current))));
        }
      }
    }
  };

  const handleWidthChange = (value: string) => {
    setNewWidth(value);
    lastEditedRef.current = 'width';
    if (!keepAspectRatio) return;

    const w = parsePositiveInt(value);
    if (!w || aspectRatioRef.current <= 0) return;
    const h = Math.max(1, Math.round(w / aspectRatioRef.current));
    setNewHeight(String(h));
  };

  const handleHeightChange = (value: string) => {
    setNewHeight(value);
    lastEditedRef.current = 'height';
    if (!keepAspectRatio) return;

    const h = parsePositiveInt(value);
    if (!h || aspectRatioRef.current <= 0) return;
    const w = Math.max(1, Math.round(h * aspectRatioRef.current));
    setNewWidth(String(w));
  };

  const handleApply = () => {
    const w = parsedSize.width;
    const h = parsedSize.height;
    if (!w || !h) return;

    const options: ResizeCanvasOptions = {
      width: w,
      height: h,
      anchor,
      scaleContent,
      extensionColor: resolveExtensionColor(extensionPreset, backgroundColor),
      resampleMode,
    };
    onApply(options);
  };

  if (!isOpen) return null;

  const anchors: ResizeCanvasOptions['anchor'][] = [
    'top-left',
    'top',
    'top-right',
    'left',
    'center',
    'right',
    'bottom-left',
    'bottom',
    'bottom-right',
  ];

  return (
    <div className="canvas-size-overlay" onClick={onClose}>
      <div className="canvas-size-panel mica-panel" onClick={(e) => e.stopPropagation()}>
        <div className="mica-panel-header canvas-size-header">
          <h2>Canvas Size</h2>
          <button className="canvas-size-close-btn" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="canvas-size-body">
          <div className="canvas-size-field">
            <label>Current</label>
            <div className="canvas-size-current">
              {currentWidth} × {currentHeight} px
            </div>
          </div>

          <div className="canvas-size-row">
            <div className="canvas-size-field">
              <label>Width</label>
              <input
                type="number"
                min={1}
                step={1}
                value={newWidth}
                onChange={(e) => handleWidthChange(e.target.value)}
              />
            </div>

            <button
              className={`canvas-size-link-btn ${keepAspectRatio ? 'active' : ''}`}
              onClick={handleToggleKeepAspectRatio}
              title={keepAspectRatio ? 'Keep aspect ratio (on)' : 'Keep aspect ratio (off)'}
            >
              {keepAspectRatio ? <Link2 size={16} /> : <Unlink2 size={16} />}
            </button>

            <div className="canvas-size-field">
              <label>Height</label>
              <input
                type="number"
                min={1}
                step={1}
                value={newHeight}
                onChange={(e) => handleHeightChange(e.target.value)}
              />
            </div>
          </div>

          <div className="canvas-size-row">
            <div className="canvas-size-field">
              <label>Mode</label>
              <div className="canvas-size-mode">
                <button
                  className={!scaleContent ? 'active' : ''}
                  onClick={() => setScaleContent(false)}
                  type="button"
                  title="Crop/Extend canvas"
                >
                  Crop/Extend
                </button>
                <button
                  className={scaleContent ? 'active' : ''}
                  onClick={() => setScaleContent(true)}
                  type="button"
                  title="Scale existing content"
                >
                  Scale Content
                </button>
              </div>
            </div>
          </div>

          <div className="canvas-size-section">
            <div className="canvas-size-section-title">Anchor</div>
            <fieldset className="canvas-size-anchor-fieldset" disabled={scaleContent}>
              <div className="canvas-size-anchor-grid">
                {anchors.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={`canvas-size-anchor-btn ${a === anchor ? 'selected' : ''}`}
                    onClick={() => setAnchor(a)}
                    title={a}
                  >
                    {getAnchorLabel(a)}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          <div className="canvas-size-row">
            <div className="canvas-size-field">
              <label>Extension Fill</label>
              <select
                className="canvas-size-select"
                value={extensionPreset}
                onChange={(e) => setExtensionPreset(e.target.value as ExtensionPreset)}
                disabled={scaleContent}
              >
                <option value="transparent">Transparent</option>
                <option value="white">White</option>
                <option value="black">Black</option>
                <option value="current-bg">Current Background</option>
              </select>
            </div>

            <div className="canvas-size-field">
              <label>Resample</label>
              <select
                className="canvas-size-select"
                value={resampleMode}
                onChange={(e) =>
                  setResampleMode(e.target.value as ResizeCanvasOptions['resampleMode'])
                }
                disabled={!scaleContent}
              >
                <option value="nearest">Nearest</option>
                <option value="bilinear">Bilinear</option>
                <option value="bicubic">Bicubic</option>
              </select>
            </div>
          </div>

          <div className="canvas-size-actions">
            <button className="canvas-size-btn" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="canvas-size-btn primary"
              onClick={handleApply}
              disabled={!canApply}
              type="button"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

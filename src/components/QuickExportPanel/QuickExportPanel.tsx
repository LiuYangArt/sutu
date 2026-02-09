import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Link2, Share, FolderOpen, ArrowUp } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { useDocumentStore } from '@/stores/document';
import { useSettingsStore } from '@/stores/settings';
import { useToolStore } from '@/stores/tool';
import { useToastStore } from '@/stores/toast';
import {
  buildDefaultQuickExportPath,
  getExtensionForQuickExportFormat,
  getMimeTypeForQuickExportFormat,
  isLikelyValidQuickExportPath,
  replacePathExtension,
  resolveQuickExportBackgroundColor,
  type QuickExportBackgroundPreset,
  type QuickExportFormat,
} from '@/utils/quickExport';
import './QuickExportPanel.css';

const ENCODE_QUALITY = 0.92;

function parsePositiveInt(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function getFilters(format: QuickExportFormat): Array<{ name: string; extensions: string[] }> {
  switch (format) {
    case 'jpg':
      return [{ name: 'JPEG Image', extensions: ['jpg', 'jpeg'] }];
    case 'webp':
      return [{ name: 'WebP Image', extensions: ['webp'] }];
    case 'png':
      return [{ name: 'PNG Image', extensions: ['png'] }];
  }
}

function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode flattened image'));
    image.src = dataUrl;
  });
}

async function canvasToBytes(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number
): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((next) => resolve(next), mimeType, quality);
  });
  if (blob) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  const dataUrl = canvas.toDataURL(mimeType, quality);
  const base64 = dataUrl.split(',')[1] ?? '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveInitialDimension(value: number, fallback: number): number {
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return fallback;
}

interface QuickExportPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function QuickExportPanel({ isOpen, onClose }: QuickExportPanelProps): JSX.Element | null {
  const doc = useDocumentStore((s) => ({
    width: s.width,
    height: s.height,
    filePath: s.filePath,
  }));
  const backgroundColor = useToolStore((s) => s.backgroundColor);
  const quickExport = useSettingsStore((s) => s.quickExport);
  const setQuickExport = useSettingsStore((s) => s.setQuickExport);
  const pushToast = useToastStore((s) => s.pushToast);

  const [widthInput, setWidthInput] = useState(String(doc.width));
  const [heightInput, setHeightInput] = useState(String(doc.height));
  const [format, setFormat] = useState<QuickExportFormat>('png');
  const [exportPath, setExportPath] = useState('');
  const [transparentBackground, setTransparentBackground] = useState(true);
  const [backgroundPreset, setBackgroundPreset] =
    useState<QuickExportBackgroundPreset>('current-bg');
  const [isExporting, setIsExporting] = useState(false);

  const aspectRatioRef = useRef(doc.width / Math.max(1, doc.height));

  useEffect(() => {
    if (!isOpen) return;

    const initialWidth = resolveInitialDimension(quickExport.lastWidth, doc.width);
    const initialHeight = resolveInitialDimension(quickExport.lastHeight, doc.height);
    const initialFormat = quickExport.lastFormat;

    let initialPath = quickExport.lastPath.trim();
    if (!initialPath && doc.filePath) {
      initialPath = buildDefaultQuickExportPath(doc.filePath, initialFormat);
    }
    if (initialPath) {
      initialPath = replacePathExtension(initialPath, initialFormat);
    }

    setWidthInput(String(initialWidth));
    setHeightInput(String(initialHeight));
    setFormat(initialFormat);
    setExportPath(initialPath);
    setTransparentBackground(initialFormat === 'jpg' ? false : quickExport.transparentBackground);
    setBackgroundPreset(quickExport.backgroundPreset);
    setIsExporting(false);
    aspectRatioRef.current = initialWidth / Math.max(1, initialHeight);
  }, [isOpen, doc.width, doc.height, doc.filePath, quickExport]);

  const parsedSize = useMemo(
    () => ({
      width: parsePositiveInt(widthInput),
      height: parsePositiveInt(heightInput),
    }),
    [widthInput, heightInput]
  );

  const canUseTransparency = format !== 'jpg';
  const effectiveTransparentBackground = canUseTransparency && transparentBackground;
  const canExport =
    !isExporting &&
    parsedSize.width !== null &&
    parsedSize.height !== null &&
    isLikelyValidQuickExportPath(exportPath);

  const handleWidthChange = (value: string) => {
    setWidthInput(value);
    const width = parsePositiveInt(value);
    if (!width || aspectRatioRef.current <= 0) return;

    const height = Math.max(1, Math.round(width / aspectRatioRef.current));
    setHeightInput(String(height));
    setQuickExport({ lastWidth: width, lastHeight: height });
  };

  const handleHeightChange = (value: string) => {
    setHeightInput(value);
    const height = parsePositiveInt(value);
    if (!height || aspectRatioRef.current <= 0) return;

    const width = Math.max(1, Math.round(height * aspectRatioRef.current));
    setWidthInput(String(width));
    setQuickExport({ lastWidth: width, lastHeight: height });
  };

  const handleFormatChange = (nextFormat: QuickExportFormat) => {
    const nextPath = exportPath ? replacePathExtension(exportPath, nextFormat) : exportPath;
    const nextTransparent = nextFormat === 'jpg' ? false : transparentBackground;
    setFormat(nextFormat);
    setExportPath(nextPath);
    setTransparentBackground(nextTransparent);
    setQuickExport({
      lastFormat: nextFormat,
      lastPath: nextPath,
      transparentBackground: nextTransparent,
    });
  };

  const handleTransparentChange = (checked: boolean) => {
    if (!canUseTransparency) return;
    setTransparentBackground(checked);
    setQuickExport({ transparentBackground: checked });
  };

  const handleBackgroundPresetChange = (nextPreset: QuickExportBackgroundPreset) => {
    setBackgroundPreset(nextPreset);
    setQuickExport({ backgroundPreset: nextPreset });
  };

  const handlePathBlur = () => {
    const trimmed = exportPath.trim();
    if (!trimmed) {
      setExportPath('');
      setQuickExport({ lastPath: '' });
      return;
    }
    const normalized = replacePathExtension(trimmed, format);
    setExportPath(normalized);
    setQuickExport({ lastPath: normalized });
  };

  const handlePickPath = async () => {
    const defaultPath =
      exportPath.trim() ||
      (doc.filePath ? buildDefaultQuickExportPath(doc.filePath, format) : '') ||
      `Untitled.${getExtensionForQuickExportFormat(format)}`;

    try {
      const selected = await save({
        title: 'Select Export Path',
        defaultPath,
        filters: getFilters(format),
      });

      if (typeof selected !== 'string' || !selected.trim()) {
        return;
      }
      const normalized = replacePathExtension(selected, format);
      setExportPath(normalized);
      setQuickExport({ lastPath: normalized });
    } catch (error) {
      pushToast(`Failed to choose export path: ${getErrorMessage(error)}`, { variant: 'error' });
    }
  };

  const handleReveal = async () => {
    const path = exportPath.trim();
    if (!isLikelyValidQuickExportPath(path)) {
      pushToast('Please configure a valid export path first.', { variant: 'error' });
      return;
    }
    try {
      await invoke('reveal_in_explorer', { path });
    } catch (error) {
      pushToast(`Failed to open explorer: ${getErrorMessage(error)}`, { variant: 'error' });
    }
  };

  const handleExport = async () => {
    const width = parsedSize.width;
    const height = parsedSize.height;
    const path = exportPath.trim();
    if (!width || !height || !isLikelyValidQuickExportPath(path)) {
      pushToast('Please enter valid export size and path.', { variant: 'error' });
      return;
    }

    const outputPath = replacePathExtension(path, format);
    setIsExporting(true);
    try {
      const win = window as Window & {
        __getFlattenedImage?: () => Promise<string | undefined>;
      };
      const getFlattenedImage = win.__getFlattenedImage;
      if (typeof getFlattenedImage !== 'function') {
        throw new Error('Missing API: window.__getFlattenedImage');
      }

      const flattenedDataUrl = await getFlattenedImage();
      if (!flattenedDataUrl) {
        throw new Error('Flattened image is not available');
      }

      const image = await loadImageFromDataUrl(flattenedDataUrl);
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = width;
      exportCanvas.height = height;
      const ctx = exportCanvas.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to create export canvas context');
      }

      if (!effectiveTransparentBackground) {
        ctx.fillStyle = resolveQuickExportBackgroundColor(backgroundPreset, backgroundColor);
        ctx.fillRect(0, 0, width, height);
      } else {
        ctx.clearRect(0, 0, width, height);
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, width, height);

      const mimeType = getMimeTypeForQuickExportFormat(format);
      const bytes = await canvasToBytes(
        exportCanvas,
        mimeType,
        format === 'png' ? undefined : ENCODE_QUALITY
      );

      await writeFile(outputPath, bytes);

      setExportPath(outputPath);
      setQuickExport({
        lastPath: outputPath,
        lastFormat: format,
        lastWidth: width,
        lastHeight: height,
        transparentBackground: effectiveTransparentBackground,
        backgroundPreset,
      });
      pushToast(`Exported to ${outputPath}`, { variant: 'success' });
    } catch (error) {
      pushToast(`Quick export failed: ${getErrorMessage(error)}`, { variant: 'error' });
    } finally {
      setIsExporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="quick-export-overlay">
      <div className="quick-export-panel mica-panel" onClick={(e) => e.stopPropagation()}>
        <div className="mica-panel-header quick-export-header">
          <h2>Quick Export</h2>
          <button className="quick-export-close-btn" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="quick-export-body">
          <div className="quick-export-field">
            <label>Path</label>
            <div className="quick-export-path-row">
              <button
                className="quick-export-run-btn"
                onClick={handleExport}
                disabled={!canExport}
                type="button"
                title="Export"
              >
                <Share size={14} />
                <span>{isExporting ? 'Exporting...' : 'Export'}</span>
              </button>
              <input
                className="quick-export-path-input"
                aria-label="Export Path"
                value={exportPath}
                onChange={(e) => setExportPath(e.target.value)}
                onBlur={handlePathBlur}
                placeholder="Select export path..."
              />
              <button
                className="quick-export-path-btn"
                onClick={handlePickPath}
                type="button"
                title="Choose Path"
              >
                <FolderOpen size={15} />
              </button>
              <button
                className="quick-export-path-btn"
                onClick={handleReveal}
                disabled={!isLikelyValidQuickExportPath(exportPath)}
                type="button"
                title="Reveal in Explorer"
              >
                <ArrowUp size={15} />
              </button>
            </div>
          </div>

          <div className="quick-export-field">
            <label>Current</label>
            <div className="quick-export-current">
              {doc.width} × {doc.height} px
            </div>
          </div>

          <div className="quick-export-row">
            <div className="quick-export-field">
              <label>Width</label>
              <input
                type="number"
                aria-label="Export Width"
                min={1}
                step={1}
                value={widthInput}
                onChange={(e) => handleWidthChange(e.target.value)}
              />
            </div>

            <button className="quick-export-ratio-lock" type="button" title="Aspect ratio locked">
              <Link2 size={16} />
            </button>

            <div className="quick-export-field">
              <label>Height</label>
              <input
                type="number"
                aria-label="Export Height"
                min={1}
                step={1}
                value={heightInput}
                onChange={(e) => handleHeightChange(e.target.value)}
              />
            </div>
          </div>

          <div className="quick-export-row">
            <div className="quick-export-field">
              <label>File Format</label>
              <select
                className="quick-export-select"
                aria-label="Export Format"
                value={format}
                onChange={(e) => handleFormatChange(e.target.value as QuickExportFormat)}
              >
                <option value="png">PNG</option>
                <option value="jpg">JPG</option>
                <option value="webp">WebP</option>
              </select>
            </div>

            <div className="quick-export-field">
              <label>Transparent Background</label>
              <label
                className="quick-export-toggle"
                title={canUseTransparency ? '' : 'JPG does not support alpha'}
              >
                <input
                  type="checkbox"
                  aria-label="Transparent Background"
                  checked={effectiveTransparentBackground}
                  disabled={!canUseTransparency}
                  onChange={(e) => handleTransparentChange(e.target.checked)}
                />
                <span className="quick-export-toggle-slider" />
              </label>
            </div>
          </div>

          <div className="quick-export-field">
            <label>Background Fill</label>
            <select
              className="quick-export-select"
              aria-label="Background Fill"
              value={backgroundPreset}
              onChange={(e) =>
                handleBackgroundPresetChange(e.target.value as QuickExportBackgroundPreset)
              }
              disabled={effectiveTransparentBackground}
            >
              <option value="white">White</option>
              <option value="black">Black</option>
              <option value="current-bg">Current Background</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

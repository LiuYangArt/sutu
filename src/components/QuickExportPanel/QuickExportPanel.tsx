import { useEffect, useMemo, useState } from 'react';
import { X, Share, FolderOpen, ArrowUp } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { useDocumentStore } from '@/stores/document';
import { useSettingsStore } from '@/stores/settings';
import { useToolStore } from '@/stores/tool';
import { useToastStore } from '@/stores/toast';
import { useI18n } from '@/i18n';
import {
  buildDefaultQuickExportPath,
  getExtensionForQuickExportFormat,
  getMimeTypeForQuickExportFormat,
  isLikelyValidQuickExportPath,
  replacePathExtension,
  resolveQuickExportOutputSize,
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

function getFilters(
  format: QuickExportFormat,
  t: (key: string) => string
): Array<{ name: string; extensions: string[] }> {
  switch (format) {
    case 'jpg':
      return [{ name: t('quickExport.filter.jpegImage'), extensions: ['jpg', 'jpeg'] }];
    case 'webp':
      return [{ name: t('quickExport.filter.webpImage'), extensions: ['webp'] }];
    case 'png':
      return [{ name: t('quickExport.filter.pngImage'), extensions: ['png'] }];
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

function resolveInitialMaxSize(value: number, width: number, height: number): number {
  if (Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return Math.max(1, Math.max(width, height));
}

function normalizeExportPath(path: string, format: QuickExportFormat): string {
  const trimmed = path.trim();
  if (!trimmed) return '';
  return replacePathExtension(trimmed, format);
}

interface QuickExportPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function QuickExportPanel({ isOpen, onClose }: QuickExportPanelProps): JSX.Element | null {
  const { t } = useI18n();
  const doc = useDocumentStore((s) => ({
    width: s.width,
    height: s.height,
    filePath: s.filePath,
  }));
  const backgroundColor = useToolStore((s) => s.backgroundColor);
  const quickExport = useSettingsStore((s) => s.quickExport);
  const setQuickExport = useSettingsStore((s) => s.setQuickExport);
  const pushToast = useToastStore((s) => s.pushToast);
  const documentMaxSize = Math.max(doc.width, doc.height);

  const [maxSizeInput, setMaxSizeInput] = useState(String(documentMaxSize));
  const [format, setFormat] = useState<QuickExportFormat>('png');
  const [exportPath, setExportPath] = useState('');
  const [transparentBackground, setTransparentBackground] = useState(true);
  const [backgroundPreset, setBackgroundPreset] =
    useState<QuickExportBackgroundPreset>('current-bg');
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    const initialMaxSize = resolveInitialMaxSize(quickExport.maxSize, doc.width, doc.height);
    const initialFormat = quickExport.lastFormat;

    const fallbackPath = doc.filePath
      ? buildDefaultQuickExportPath(doc.filePath, initialFormat)
      : '';
    const initialPath = normalizeExportPath(quickExport.lastPath || fallbackPath, initialFormat);

    setMaxSizeInput(String(initialMaxSize));
    setFormat(initialFormat);
    setExportPath(initialPath);
    setTransparentBackground(initialFormat === 'jpg' ? false : quickExport.transparentBackground);
    setBackgroundPreset(quickExport.backgroundPreset);
    setIsExporting(false);
  }, [isOpen, doc.width, doc.height, doc.filePath, quickExport]);

  const parsedMaxSize = useMemo(() => parsePositiveInt(maxSizeInput), [maxSizeInput]);
  const resolvedOutputSize = useMemo(
    () => resolveQuickExportOutputSize(doc.width, doc.height, parsedMaxSize ?? documentMaxSize),
    [doc.width, doc.height, parsedMaxSize, documentMaxSize]
  );

  const canUseTransparency = format !== 'jpg';
  const effectiveTransparentBackground = canUseTransparency && transparentBackground;
  const canExport =
    !isExporting && parsedMaxSize !== null && isLikelyValidQuickExportPath(exportPath);

  const handleMaxSizeChange = (value: string) => {
    setMaxSizeInput(value);
    const maxSize = parsePositiveInt(value);
    if (!maxSize) return;
    setQuickExport({ maxSize });
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
    const normalized = normalizeExportPath(exportPath, format);
    if (!normalized) {
      setExportPath('');
      setQuickExport({ lastPath: '' });
      return;
    }
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
        title: t('quickExport.dialog.selectExportPath'),
        defaultPath,
        filters: getFilters(format, t),
      });

      if (typeof selected !== 'string') {
        return;
      }
      const normalized = normalizeExportPath(selected, format);
      if (!normalized) {
        return;
      }
      setExportPath(normalized);
      setQuickExport({ lastPath: normalized });
    } catch (error) {
      pushToast(t('quickExport.toast.choosePathFailed', { message: getErrorMessage(error) }), {
        variant: 'error',
      });
    }
  };

  const handleReveal = async () => {
    const path = exportPath.trim();
    if (!isLikelyValidQuickExportPath(path)) {
      pushToast(t('quickExport.toast.configureValidPathFirst'), { variant: 'error' });
      return;
    }
    try {
      await invoke('reveal_in_explorer', { path });
    } catch (error) {
      pushToast(t('quickExport.toast.openExplorerFailed', { message: getErrorMessage(error) }), {
        variant: 'error',
      });
    }
  };

  const handleExport = async () => {
    const maxSize = parsedMaxSize;
    const path = exportPath.trim();
    if (!maxSize || !isLikelyValidQuickExportPath(path)) {
      pushToast(t('quickExport.toast.invalidMaxSizeOrPath'), { variant: 'error' });
      return;
    }

    const outputPath = replacePathExtension(path, format);
    const outputSize = resolveQuickExportOutputSize(doc.width, doc.height, maxSize);
    setIsExporting(true);
    try {
      const win = window as Window & {
        __getFlattenedImage?: () => Promise<string | undefined>;
      };
      const getFlattenedImage = win.__getFlattenedImage;
      if (typeof getFlattenedImage !== 'function') {
        throw new Error(t('quickExport.error.missingFlattenApi'));
      }

      const flattenedDataUrl = await getFlattenedImage();
      if (!flattenedDataUrl) {
        throw new Error(t('quickExport.error.flattenedImageUnavailable'));
      }

      const image = await loadImageFromDataUrl(flattenedDataUrl);
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = outputSize.width;
      exportCanvas.height = outputSize.height;
      const ctx = exportCanvas.getContext('2d');
      if (!ctx) {
        throw new Error(t('quickExport.error.canvasContextUnavailable'));
      }

      if (!effectiveTransparentBackground) {
        ctx.fillStyle = resolveQuickExportBackgroundColor(backgroundPreset, backgroundColor);
        ctx.fillRect(0, 0, outputSize.width, outputSize.height);
      } else {
        ctx.clearRect(0, 0, outputSize.width, outputSize.height);
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, outputSize.width, outputSize.height);

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
        maxSize,
        transparentBackground: effectiveTransparentBackground,
        backgroundPreset,
      });
      pushToast(t('quickExport.toast.exportedTo', { path: outputPath }), { variant: 'success' });
    } catch (error) {
      pushToast(t('quickExport.toast.exportFailed', { message: getErrorMessage(error) }), {
        variant: 'error',
      });
    } finally {
      setIsExporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="quick-export-overlay">
      <div className="quick-export-panel mica-panel" onClick={(e) => e.stopPropagation()}>
        <div className="mica-panel-header quick-export-header">
          <h2>{t('quickExport.title')}</h2>
          <button className="quick-export-close-btn" onClick={onClose} title={t('common.close')}>
            <X size={18} />
          </button>
        </div>

        <div className="quick-export-body">
          <div className="quick-export-field">
            <label>{t('quickExport.path')}</label>
            <div className="quick-export-path-row">
              <button
                className="quick-export-run-btn"
                onClick={handleExport}
                disabled={!canExport}
                type="button"
                title={t('quickExport.export')}
              >
                <Share size={14} />
                <span>{isExporting ? t('quickExport.exporting') : t('quickExport.export')}</span>
              </button>
              <input
                className="quick-export-path-input"
                aria-label={t('quickExport.aria.exportPath')}
                value={exportPath}
                onChange={(e) => setExportPath(e.target.value)}
                onBlur={handlePathBlur}
                placeholder={t('quickExport.selectExportPathPlaceholder')}
              />
              <button
                className="quick-export-path-btn"
                onClick={handlePickPath}
                type="button"
                title={t('quickExport.choosePath')}
              >
                <FolderOpen size={15} />
              </button>
              <button
                className="quick-export-path-btn"
                onClick={handleReveal}
                disabled={!isLikelyValidQuickExportPath(exportPath)}
                type="button"
                title={t('quickExport.revealInExplorer')}
              >
                <ArrowUp size={15} />
              </button>
            </div>
          </div>

          <div className="quick-export-field">
            <label>{t('quickExport.outputSize')}</label>
            <div className="quick-export-current">
              {resolvedOutputSize.width} × {resolvedOutputSize.height} px
            </div>
          </div>

          <div className="quick-export-field">
            <label>{t('quickExport.maxSize')}</label>
            <input
              type="number"
              aria-label={t('quickExport.aria.exportMaxSize')}
              min={1}
              step={1}
              value={maxSizeInput}
              onChange={(e) => handleMaxSizeChange(e.target.value)}
            />
          </div>

          <div className="quick-export-row">
            <div className="quick-export-field">
              <label>{t('quickExport.fileFormat')}</label>
              <select
                className="quick-export-select"
                aria-label={t('quickExport.aria.exportFormat')}
                value={format}
                onChange={(e) => handleFormatChange(e.target.value as QuickExportFormat)}
              >
                <option value="png">PNG</option>
                <option value="jpg">JPG</option>
                <option value="webp">WebP</option>
              </select>
            </div>

            <div className="quick-export-field">
              <label>{t('quickExport.transparentBackground')}</label>
              <label
                className="quick-export-toggle"
                title={canUseTransparency ? '' : t('quickExport.jpgNoAlpha')}
              >
                <input
                  type="checkbox"
                  aria-label={t('quickExport.aria.transparentBackground')}
                  checked={effectiveTransparentBackground}
                  disabled={!canUseTransparency}
                  onChange={(e) => handleTransparentChange(e.target.checked)}
                />
                <span className="quick-export-toggle-slider" />
              </label>
            </div>
          </div>

          <div className="quick-export-field">
            <label>{t('quickExport.backgroundFill')}</label>
            <select
              className="quick-export-select"
              aria-label={t('quickExport.aria.backgroundFill')}
              value={backgroundPreset}
              onChange={(e) =>
                handleBackgroundPresetChange(e.target.value as QuickExportBackgroundPreset)
              }
              disabled={effectiveTransparentBackground}
            >
              <option value="white">{t('quickExport.background.white')}</option>
              <option value="black">{t('quickExport.background.black')}</option>
              <option value="current-bg">{t('quickExport.background.currentBackground')}</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

export type QuickExportFormat = 'png' | 'jpg' | 'webp';

export type QuickExportBackgroundPreset = 'white' | 'black' | 'current-bg';

export interface QuickExportSettings {
  lastPath: string;
  lastFormat: QuickExportFormat;
  lastWidth: number;
  lastHeight: number;
  transparentBackground: boolean;
  backgroundPreset: QuickExportBackgroundPreset;
}

export function getExtensionForQuickExportFormat(format: QuickExportFormat): string {
  if (format === 'jpg') return 'jpg';
  return format;
}

export function getMimeTypeForQuickExportFormat(format: QuickExportFormat): string {
  if (format === 'jpg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

export function replacePathExtension(path: string, format: QuickExportFormat): string {
  const trimmed = path.trim();
  if (!trimmed) return '';

  const ext = getExtensionForQuickExportFormat(format);
  const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const fileName = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  if (!fileName) return trimmed;

  const dir = lastSlash >= 0 ? trimmed.slice(0, lastSlash + 1) : '';
  const lastDot = fileName.lastIndexOf('.');
  const hasExtension = lastDot > 0 && lastDot < fileName.length - 1;
  const baseName = hasExtension ? fileName.slice(0, lastDot) : fileName;
  return `${dir}${baseName}.${ext}`;
}

export function buildDefaultQuickExportPath(
  documentPath: string,
  format: QuickExportFormat
): string {
  const trimmed = documentPath.trim();
  if (!trimmed) return '';

  const ext = getExtensionForQuickExportFormat(format);
  const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const fileName = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  if (!fileName) return '';

  const dir = lastSlash >= 0 ? trimmed.slice(0, lastSlash + 1) : '';
  const lastDot = fileName.lastIndexOf('.');
  const hasExtension = lastDot > 0;
  const baseName = hasExtension ? fileName.slice(0, lastDot) : fileName;
  if (!baseName) return '';
  return `${dir}${baseName}.${ext}`;
}

export function resolveQuickExportBackgroundColor(
  preset: QuickExportBackgroundPreset,
  currentBackgroundColor: string
): string {
  if (preset === 'white') return '#ffffff';
  if (preset === 'black') return '#000000';
  return currentBackgroundColor;
}

export function isLikelyValidQuickExportPath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  if (trimmed.endsWith('/') || trimmed.endsWith('\\')) return false;
  if (trimmed.includes('\0')) return false;
  return true;
}

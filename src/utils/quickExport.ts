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
  switch (format) {
    case 'jpg':
      return 'jpg';
    case 'png':
    case 'webp':
      return format;
  }
}

export function getMimeTypeForQuickExportFormat(format: QuickExportFormat): string {
  switch (format) {
    case 'jpg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'png':
      return 'image/png';
  }
}

interface PathSegments {
  dir: string;
  fileName: string;
  trimmed: string;
}

function splitPathSegments(path: string): PathSegments | null {
  const trimmed = path.trim();
  if (!trimmed) return null;

  const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const fileName = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  const dir = lastSlash >= 0 ? trimmed.slice(0, lastSlash + 1) : '';
  return { dir, fileName, trimmed };
}

function getFileBaseName(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  const hasExtension = lastDot > 0 && lastDot < fileName.length - 1;
  return hasExtension ? fileName.slice(0, lastDot) : fileName;
}

export function replacePathExtension(path: string, format: QuickExportFormat): string {
  const segments = splitPathSegments(path);
  if (!segments) return '';

  const ext = getExtensionForQuickExportFormat(format);
  if (!segments.fileName) return segments.trimmed;

  const baseName = getFileBaseName(segments.fileName);
  return `${segments.dir}${baseName}.${ext}`;
}

export function buildDefaultQuickExportPath(
  documentPath: string,
  format: QuickExportFormat
): string {
  const segments = splitPathSegments(documentPath);
  if (!segments) return '';

  const ext = getExtensionForQuickExportFormat(format);
  if (!segments.fileName) return '';
  const baseName = getFileBaseName(segments.fileName);
  if (!baseName) return '';
  return `${segments.dir}${baseName}.${ext}`;
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

const PROJECT_PROTOCOL_FALLBACK_BASE_URL = 'http://project.localhost';
const PROJECT_PROTOCOL_NAME = 'project';

type TauriInternals = {
  convertFileSrc?: (filePath: string, protocol?: string) => string;
};

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function getTauriConvertFileSrc(): ((filePath: string, protocol?: string) => string) | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const tauriWindow = window as Window & {
    __TAURI_INTERNALS__?: TauriInternals;
  };
  const convertFileSrc = tauriWindow.__TAURI_INTERNALS__?.convertFileSrc;
  return typeof convertFileSrc === 'function' ? convertFileSrc : null;
}

function resolveProjectBaseUrlFromTauri(): string | null {
  const convertFileSrc = getTauriConvertFileSrc();
  if (!convertFileSrc) {
    return null;
  }

  try {
    const resolved = convertFileSrc('', PROJECT_PROTOCOL_NAME);
    if (typeof resolved !== 'string' || resolved.trim() === '') {
      return null;
    }
    const normalized = normalizeBaseUrl(resolved);
    return normalized || null;
  } catch {
    return null;
  }
}

export function getProjectProtocolBaseUrl(): string {
  return resolveProjectBaseUrlFromTauri() ?? PROJECT_PROTOCOL_FALLBACK_BASE_URL;
}

function normalizeResourcePath(path: string): string {
  return path.trim().replace(/^\/+/, '');
}

export function buildProjectProtocolUrl(path: string): string {
  const baseUrl = getProjectProtocolBaseUrl();
  const normalizedPath = normalizeResourcePath(path);
  if (!normalizedPath) {
    return baseUrl;
  }
  return `${baseUrl}/${normalizedPath}`;
}

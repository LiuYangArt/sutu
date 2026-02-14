const PROJECT_PROTOCOL_FALLBACK_BASE_URL = 'http://project.localhost';

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

export function getProjectProtocolBaseUrl(): string {
  const convertFileSrc = getTauriConvertFileSrc();
  if (!convertFileSrc) {
    return PROJECT_PROTOCOL_FALLBACK_BASE_URL;
  }

  try {
    const resolved = convertFileSrc('', 'project');
    if (typeof resolved !== 'string' || resolved.trim() === '') {
      return PROJECT_PROTOCOL_FALLBACK_BASE_URL;
    }
    const normalized = normalizeBaseUrl(resolved);
    return normalized || PROJECT_PROTOCOL_FALLBACK_BASE_URL;
  } catch {
    return PROJECT_PROTOCOL_FALLBACK_BASE_URL;
  }
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

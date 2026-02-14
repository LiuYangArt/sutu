export type TauriConvertFileSrc = (filePath: string, protocol?: string) => string;

export type TauriInternals = {
  convertFileSrc?: TauriConvertFileSrc;
};

export type TauriInternalsWindow = Window & {
  __TAURI_INTERNALS__?: TauriInternals;
};

export function getTauriInternalsSnapshot(): TauriInternals | undefined {
  return (window as TauriInternalsWindow).__TAURI_INTERNALS__;
}

export function restoreTauriInternals(snapshot: TauriInternals | undefined): void {
  const mockWindow = window as TauriInternalsWindow;
  if (snapshot === undefined) {
    delete mockWindow.__TAURI_INTERNALS__;
    return;
  }
  mockWindow.__TAURI_INTERNALS__ = snapshot;
}

export function setTauriConvertFileSrcMock(convertFileSrc: TauriConvertFileSrc): void {
  (window as TauriInternalsWindow).__TAURI_INTERNALS__ = { convertFileSrc };
}

export function createPlatformConvertFileSrcMock(
  platform: 'windows' | 'macos'
): TauriConvertFileSrc {
  if (platform === 'windows') {
    return function convertFileSrc(_filePath: string, protocol: string = 'asset'): string {
      return `http://${protocol}.localhost/`;
    };
  }

  return function convertFileSrc(_filePath: string, protocol: string = 'asset'): string {
    return `${protocol}://localhost/`;
  };
}

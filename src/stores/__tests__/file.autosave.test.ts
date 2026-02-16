import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  save: vi.fn(),
  open: vi.fn(),
}));

const pathMocks = vi.hoisted(() => ({
  tempDir: vi.fn(),
  join: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  exists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: coreMocks.invoke,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: dialogMocks.save,
  open: dialogMocks.open,
}));

vi.mock('@tauri-apps/api/path', () => ({
  tempDir: pathMocks.tempDir,
  join: pathMocks.join,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppConfig: 'AppConfig' },
  exists: fsMocks.exists,
  readTextFile: fsMocks.readTextFile,
  writeTextFile: fsMocks.writeTextFile,
  mkdir: fsMocks.mkdir,
}));

import { useDocumentStore } from '../document';
import { useFileStore } from '../file';
import { useSettingsStore } from '../settings';

type ExportWindow = Window & {
  __getThumbnailBytes?: () => Promise<number[] | undefined>;
  __getFlattenedImageBytes?: () => Promise<number[] | undefined>;
  __getLayerImageBytes?: (layerId: string) => Promise<number[] | undefined>;
};

function createLoadedProject() {
  return {
    width: 800,
    height: 600,
    dpi: 72,
    layers: [
      {
        id: 'layer_1',
        name: 'Layer 1',
        type: 'raster',
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'normal',
        offsetX: 0,
        offsetY: 0,
      },
    ],
  };
}

function getInvokeCalls(command: string) {
  return coreMocks.invoke.mock.calls.filter(([cmd]) => cmd === command);
}

function getLastPersistedSession<T extends object>(): T {
  const raw =
    fsMocks.writeTextFile.mock.calls[fsMocks.writeTextFile.mock.calls.length - 1]?.[1] ?? '{}';
  return JSON.parse(String(raw)) as T;
}

describe('file store autosave and startup restore', () => {
  let getThumbnailBytesMock: ReturnType<typeof vi.fn>;
  let getFlattenedImageBytesMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    coreMocks.invoke.mockReset();
    dialogMocks.save.mockReset();
    dialogMocks.open.mockReset();
    pathMocks.tempDir.mockReset();
    pathMocks.join.mockReset();
    fsMocks.exists.mockReset();
    fsMocks.readTextFile.mockReset();
    fsMocks.writeTextFile.mockReset();
    fsMocks.mkdir.mockReset();

    pathMocks.tempDir.mockResolvedValue('C:/temp/');
    pathMocks.join.mockImplementation(
      (root: string, next: string) => `${root.replace(/\/+$/, '')}/${next}`
    );
    fsMocks.exists.mockResolvedValue(false);
    fsMocks.readTextFile.mockResolvedValue('{}');
    fsMocks.writeTextFile.mockResolvedValue(undefined);
    fsMocks.mkdir.mockResolvedValue(undefined);

    coreMocks.invoke.mockImplementation(async (cmd: string, payload?: Record<string, unknown>) => {
      if (cmd === 'save_project_v2') {
        return { success: true, path: payload?.path };
      }
      if (cmd === 'load_project_v2') {
        return createLoadedProject();
      }
      if (cmd === 'delete_file_if_exists') {
        return null;
      }
      if (cmd === 'report_benchmark') {
        return null;
      }
      return null;
    });

    if (!window.requestAnimationFrame) {
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      }) as typeof window.requestAnimationFrame;
    }

    getThumbnailBytesMock = vi.fn().mockResolvedValue([1, 2, 3]);
    getFlattenedImageBytesMock = vi.fn().mockResolvedValue([4, 5, 6]);
    const exportWindow = window as ExportWindow;
    exportWindow.__getThumbnailBytes = getThumbnailBytesMock as unknown as () => Promise<
      number[] | undefined
    >;
    exportWindow.__getFlattenedImageBytes = getFlattenedImageBytesMock as unknown as () => Promise<
      number[] | undefined
    >;
    exportWindow.__getLayerImageBytes = vi.fn().mockResolvedValue(undefined);

    useFileStore.setState({ isSaving: false, isLoading: false, error: null });
    useDocumentStore.getState().reset();
    useDocumentStore.setState({
      width: 1200,
      height: 800,
      dpi: 72,
      layers: [],
      filePath: null,
      fileFormat: null,
      isDirty: false,
    });
    useSettingsStore.setState((state) => ({
      ...state,
      general: {
        language: 'en-US',
        autosaveIntervalMinutes: 10,
        openLastFileOnStartup: true,
        recentFiles: [],
        selectionAutoFillEnabled: false,
        selectionPreviewTranslucent: true,
      },
    }));
  });

  it('autosaves unsaved dirty document to temp ORA', async () => {
    useDocumentStore.setState({ isDirty: true, filePath: null, fileFormat: null });

    await useFileStore.getState().runAutoSaveTick();

    const saveCalls = getInvokeCalls('save_project_v2');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0]?.[1]).toMatchObject({
      path: 'C:/temp/sutu-autosave.ora',
      format: 'ora',
    });
    expect(getThumbnailBytesMock).not.toHaveBeenCalled();
    expect(getFlattenedImageBytesMock).not.toHaveBeenCalled();

    const sessionWrite =
      fsMocks.writeTextFile.mock.calls[fsMocks.writeTextFile.mock.calls.length - 1];
    expect(sessionWrite).toBeDefined();
    expect(String(sessionWrite?.[0])).toBe('autosave-session.json');
    const persisted = JSON.parse(String(sessionWrite?.[1] ?? '{}')) as {
      hasUnsavedTemp?: boolean;
    };
    expect(persisted.hasUnsavedTemp).toBe(true);
    expect(useDocumentStore.getState().isDirty).toBe(false);
  });

  it('autosaves dirty saved document to current path', async () => {
    useDocumentStore.setState({
      isDirty: true,
      filePath: 'C:/work/project.psd',
      fileFormat: 'psd',
    });

    await useFileStore.getState().runAutoSaveTick();

    const saveCalls = getInvokeCalls('save_project_v2');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0]?.[1]).toMatchObject({
      path: 'C:/work/project.psd',
      format: 'psd',
    });
    expect(getThumbnailBytesMock).not.toHaveBeenCalled();
    expect(getFlattenedImageBytesMock).toHaveBeenCalledTimes(1);

    const persisted = getLastPersistedSession<{
      hasUnsavedTemp?: boolean;
      lastSavedPath?: string | null;
    }>();
    expect(persisted.hasUnsavedTemp).toBe(false);
    expect(persisted.lastSavedPath).toBe('C:/work/project.psd');
  });

  it('falls back to temp autosave when saving current file fails', async () => {
    useDocumentStore.setState({
      isDirty: true,
      filePath: 'C:/work/project.psd',
      fileFormat: 'psd',
    });

    coreMocks.invoke.mockImplementation(async (cmd: string, payload?: Record<string, unknown>) => {
      if (cmd === 'load_project_v2') {
        return createLoadedProject();
      }
      if (cmd === 'save_project_v2') {
        const path = String(payload?.path ?? '');
        if (path === 'C:/work/project.psd') {
          return { success: false, error: 'disk error' };
        }
        return { success: true, path };
      }
      if (cmd === 'delete_file_if_exists') {
        return null;
      }
      if (cmd === 'report_benchmark') {
        return null;
      }
      return null;
    });

    await useFileStore.getState().runAutoSaveTick();

    const saveV2Calls = getInvokeCalls('save_project_v2');
    expect(saveV2Calls.length).toBe(2);
    expect(saveV2Calls[0]?.[1]).toMatchObject({ path: 'C:/work/project.psd', format: 'psd' });
    expect(saveV2Calls[1]?.[1]).toMatchObject({
      path: 'C:/temp/sutu-autosave.ora',
      format: 'ora',
    });

    const persisted = getLastPersistedSession<{
      hasUnsavedTemp?: boolean;
      lastSavedPath?: string | null;
    }>();
    expect(persisted.hasUnsavedTemp).toBe(true);
    expect(persisted.lastSavedPath).toBe('C:/work/project.psd');
  });

  it('restores temp autosave first and keeps document untitled', async () => {
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readTextFile.mockResolvedValue(
      JSON.stringify({
        hasUnsavedTemp: true,
        lastSavedPath: 'C:/work/last.ora',
      })
    );

    const restored = await useFileStore.getState().restoreOnStartup();

    expect(restored).toBe(true);
    const loadV2Calls = getInvokeCalls('load_project_v2');
    expect(loadV2Calls.length).toBe(1);
    expect(loadV2Calls[0]?.[1]).toMatchObject({ path: 'C:/temp/sutu-autosave.ora' });
    expect(useDocumentStore.getState().filePath).toBeNull();
    expect(useDocumentStore.getState().fileFormat).toBeNull();
  });

  it('falls back to last saved file when temp autosave is corrupted', async () => {
    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readTextFile.mockResolvedValue(
      JSON.stringify({
        hasUnsavedTemp: true,
        lastSavedPath: 'C:/work/last.ora',
      })
    );

    coreMocks.invoke.mockImplementation(async (cmd: string, payload?: Record<string, unknown>) => {
      if (cmd === 'load_project_v2') {
        const path = String(payload?.path ?? '');
        if (path === 'C:/temp/sutu-autosave.ora') {
          throw new Error('ZIP error: invalid Zip archive');
        }
        return createLoadedProject();
      }
      if (cmd === 'delete_file_if_exists') {
        return null;
      }
      if (cmd === 'report_benchmark') {
        return null;
      }
      return null;
    });

    const restored = await useFileStore.getState().restoreOnStartup();
    expect(restored).toBe(true);

    const loadV2Calls = getInvokeCalls('load_project_v2');
    expect(loadV2Calls.length).toBe(2);
    expect(loadV2Calls[0]?.[1]).toMatchObject({ path: 'C:/temp/sutu-autosave.ora' });
    expect(loadV2Calls[1]?.[1]).toMatchObject({ path: 'C:/work/last.ora' });

    const deleteCalls = getInvokeCalls('delete_file_if_exists');
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0]?.[1]).toMatchObject({ path: 'C:/temp/sutu-autosave.ora' });

    const lastPersisted = getLastPersistedSession<{
      hasUnsavedTemp?: boolean;
      lastSavedPath?: string | null;
    }>();
    expect(lastPersisted.hasUnsavedTemp).toBe(false);
    expect(lastPersisted.lastSavedPath).toBe('C:/work/last.ora');
  });

  it('does not restore when startup toggle is disabled', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      general: {
        ...state.general,
        openLastFileOnStartup: false,
      },
    }));

    fsMocks.exists.mockResolvedValue(true);
    fsMocks.readTextFile.mockResolvedValue(
      JSON.stringify({
        hasUnsavedTemp: true,
        lastSavedPath: 'C:/work/last.ora',
      })
    );

    const restored = await useFileStore.getState().restoreOnStartup();
    expect(restored).toBe(false);

    const loadCalls = getInvokeCalls('load_project_v2');
    expect(loadCalls.length).toBe(0);
  });

  it('tracks opened file into recent list', async () => {
    await useFileStore.getState().openPath('C:/work/recent-test.ora', {
      asUntitled: false,
      rememberAsLastSaved: true,
      clearUnsavedTemp: true,
      trackRecent: true,
    });

    expect(useSettingsStore.getState().general.recentFiles).toEqual(['C:/work/recent-test.ora']);
  });

  it('prunes missing recent files on startup', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      general: {
        ...state.general,
        openLastFileOnStartup: false,
        recentFiles: ['C:/work/exists-a.psd', 'C:/work/missing.ora', 'C:/work/exists-b.ora'],
      },
    }));

    fsMocks.exists.mockImplementation(async (path: string) => path !== 'C:/work/missing.ora');

    const restored = await useFileStore.getState().restoreOnStartup();
    expect(restored).toBe(false);
    expect(useSettingsStore.getState().general.recentFiles).toEqual([
      'C:/work/exists-a.psd',
      'C:/work/exists-b.ora',
    ]);
  });

  it('clears temp autosave after first manual save', async () => {
    dialogMocks.save.mockResolvedValue('C:/work/newdoc.ora');
    useDocumentStore.setState({
      filePath: null,
      fileFormat: null,
      isDirty: true,
      layers: [],
    });

    const saved = await useFileStore.getState().save(false);
    expect(saved).toBe(true);

    const deleteCalls = getInvokeCalls('delete_file_if_exists');
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0]?.[1]).toMatchObject({ path: 'C:/temp/sutu-autosave.ora' });
  });
});

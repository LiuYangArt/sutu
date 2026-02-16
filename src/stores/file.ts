/**
 * File operations store for save/load/autosave/startup-restore functionality
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { join, tempDir } from '@tauri-apps/api/path';
import { save, open } from '@tauri-apps/plugin-dialog';
import { BaseDirectory, exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { useDocumentStore, FileFormat, Layer } from './document';
import { useSettingsStore } from './settings';
import { appHyphenStorageKey } from '@/constants/appMeta';
import { t } from '@/i18n';

const SESSION_FILE = 'autosave-session.json';
const TEMP_AUTOSAVE_FILE_NAME = `${appHyphenStorageKey('autosave')}.ora`;

// Types matching Rust backend
interface LayerDataV2 {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: string;
  isBackground?: boolean;
  offsetX: number;
  offsetY: number;
  layerPngBytes?: number[];
  legacyImageDataBase64?: string;
}

interface BackendBenchmark {
  sessionId: string;
  filePath: string;
  format: string;
  fileReadMs: number;
  formatParseMs: number;
  decodeCacheMs: number;
  totalMs: number;
  layerCount: number;
}

interface ProjectDataV2 {
  width: number;
  height: number;
  dpi: number;
  layers: LayerDataV2[];
  flattenedPngBytes?: number[];
  thumbnailPngBytes?: number[];
  legacyFlattenedImageBase64?: string;
  legacyThumbnailBase64?: string;
  benchmark?: BackendBenchmark;
}

interface FileOperationResult {
  success: boolean;
  path?: string;
  error?: string;
}

interface AutosaveSessionData {
  lastSavedPath: string | null;
  hasUnsavedTemp: boolean;
}

interface SaveTargetResult {
  success: boolean;
  error?: string;
}

interface OpenPathOptions {
  asUntitled?: boolean;
  rememberAsLastSaved?: boolean;
  clearUnsavedTemp?: boolean;
  suppressErrorLog?: boolean;
  trackRecent?: boolean;
}

interface SaveTargetOptions {
  updateDocumentPath?: boolean;
  markDocumentClean?: boolean;
  includeThumbnail?: boolean;
  includeFlattenedImage?: boolean;
}

const AUTOSAVE_PRIMARY_TARGET_OPTIONS: SaveTargetOptions = {
  updateDocumentPath: false,
  markDocumentClean: true,
  includeThumbnail: false,
};

const AUTOSAVE_TEMP_TARGET_OPTIONS: SaveTargetOptions = {
  updateDocumentPath: false,
  markDocumentClean: true,
  includeThumbnail: false,
  includeFlattenedImage: false,
};

type CanvasExportWindow = Window & {
  __getThumbnailBytes?: () => Promise<number[] | undefined>;
  __getFlattenedImageBytes?: () => Promise<number[] | undefined>;
  __getLayerImageBytes?: (layerId: string) => Promise<number[] | undefined>;
};

interface LayerImageLoadPayload {
  id: string;
  imageData?: string;
  offsetX?: number;
  offsetY?: number;
}

interface FileState {
  isSaving: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  save: (saveAs?: boolean) => Promise<boolean>;
  open: () => Promise<boolean>;
  openPath: (path: string, options?: OpenPathOptions) => Promise<boolean>;
  pruneMissingRecentFiles: () => Promise<void>;
  runAutoSaveTick: () => Promise<void>;
  restoreOnStartup: () => Promise<boolean>;
  reset: () => void;
}

const DEFAULT_SESSION: AutosaveSessionData = {
  lastSavedPath: null,
  hasUnsavedTemp: false,
};

function getCanvasExportWindow(): CanvasExportWindow {
  return window as CanvasExportWindow;
}

async function getLayerImageBytes(layerId: string): Promise<number[] | undefined> {
  const win = getCanvasExportWindow();
  return win.__getLayerImageBytes?.(layerId);
}

async function getThumbnailBytes(): Promise<number[] | undefined> {
  const win = getCanvasExportWindow();
  return win.__getThumbnailBytes?.();
}

async function getFlattenedImageBytes(): Promise<number[] | undefined> {
  const win = getCanvasExportWindow();
  return win.__getFlattenedImageBytes?.();
}

function detectFileFormatFromPath(path: string): FileFormat | null {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.psd')) return 'psd';
  if (lowerPath.endsWith('.ora')) return 'ora';
  return null;
}

function resolveSaveTarget(path: string): { path: string; format: FileFormat } {
  const detectedFormat = detectFileFormatFromPath(path);
  if (detectedFormat) {
    return { path, format: detectedFormat };
  }

  // Default to PSD if no recognized extension
  return { path: `${path}.psd`, format: 'psd' };
}

function normalizeImageDataToDataUrl(imageData?: string): string | undefined {
  if (!imageData) return undefined;
  if (imageData.startsWith('data:')) return imageData;
  return `data:image/png;base64,${imageData}`;
}

function normalizeOpenPathOptions(options?: OpenPathOptions): OpenPathOptions {
  return {
    asUntitled: false,
    rememberAsLastSaved: false,
    clearUnsavedTemp: false,
    suppressErrorLog: false,
    trackRecent: true,
    ...options,
  };
}

function hasSamePathOrder(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function parseSessionData(raw: string): AutosaveSessionData {
  try {
    const parsed = JSON.parse(raw) as Partial<AutosaveSessionData>;
    return {
      lastSavedPath: typeof parsed.lastSavedPath === 'string' ? parsed.lastSavedPath : null,
      hasUnsavedTemp: parsed.hasUnsavedTemp === true,
    };
  } catch {
    return { ...DEFAULT_SESSION };
  }
}

async function ensureAppConfigDir(): Promise<void> {
  await mkdir('', { baseDir: BaseDirectory.AppConfig, recursive: true });
}

async function readSessionData(): Promise<AutosaveSessionData> {
  try {
    const sessionExists = await exists(SESSION_FILE, { baseDir: BaseDirectory.AppConfig });
    if (!sessionExists) return { ...DEFAULT_SESSION };
    const raw = await readTextFile(SESSION_FILE, { baseDir: BaseDirectory.AppConfig });
    return parseSessionData(raw);
  } catch {
    return { ...DEFAULT_SESSION };
  }
}

async function writeSessionData(data: AutosaveSessionData): Promise<void> {
  try {
    await ensureAppConfigDir();
    await writeTextFile(SESSION_FILE, JSON.stringify(data, null, 2), {
      baseDir: BaseDirectory.AppConfig,
    });
  } catch {
    // Session persistence is best-effort.
  }
}

async function updateSessionData(
  updater: (prev: AutosaveSessionData) => AutosaveSessionData
): Promise<AutosaveSessionData> {
  const prev = await readSessionData();
  const next = updater(prev);
  await writeSessionData(next);
  return next;
}

async function getTempAutosavePath(): Promise<string> {
  const tempRoot = await tempDir();
  return join(tempRoot, TEMP_AUTOSAVE_FILE_NAME);
}

function layerToLayerDataV2(layer: Layer, layerPngBytes?: number[]): LayerDataV2 {
  return {
    id: layer.id,
    name: layer.name,
    type: layer.type,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity / 100,
    blendMode: layer.blendMode,
    isBackground: layer.isBackground,
    offsetX: 0,
    offsetY: 0,
    layerPngBytes,
  };
}

function layerDataV2ToLayer(data: LayerDataV2): Layer {
  return {
    id: data.id,
    name: data.name,
    type: data.type as 'raster' | 'group' | 'adjustment',
    visible: data.visible,
    locked: data.locked,
    opacity: Math.round(data.opacity * 100),
    blendMode: data.blendMode as Layer['blendMode'],
    isBackground: data.isBackground,
    thumbnail: normalizeImageDataToDataUrl(data.legacyImageDataBase64),
  };
}

function layerV2ToLoadImagePayload(layer: LayerDataV2): LayerImageLoadPayload {
  return {
    id: layer.id,
    imageData: normalizeImageDataToDataUrl(layer.legacyImageDataBase64),
    offsetX: layer.offsetX,
    offsetY: layer.offsetY,
  };
}

interface ProjectSnapshotOptions {
  includeThumbnail: boolean;
  includeFlattenedImage: boolean;
}

function ensureRequiredBytes(
  bytes: number[] | undefined,
  message: string
): asserts bytes is number[] {
  if (!bytes) {
    throw new Error(message);
  }
}

async function buildProjectDataSnapshotV2(options: ProjectSnapshotOptions): Promise<ProjectDataV2> {
  const docStore = useDocumentStore.getState();
  const layerDataPromises = docStore.layers.map(async (layer) => {
    if (layer.type !== 'raster') {
      return layerToLayerDataV2(layer, undefined);
    }
    const layerPngBytes = await getLayerImageBytes(layer.id);
    ensureRequiredBytes(layerPngBytes, `[file] Missing layer bytes for raster layer: ${layer.id}`);
    return layerToLayerDataV2(layer, layerPngBytes);
  });
  const layers = await Promise.all(layerDataPromises);

  const [thumbnailPngBytes, flattenedPngBytes] = await Promise.all([
    options.includeThumbnail ? getThumbnailBytes() : Promise.resolve(undefined),
    options.includeFlattenedImage ? getFlattenedImageBytes() : Promise.resolve(undefined),
  ]);

  if (options.includeThumbnail) {
    ensureRequiredBytes(thumbnailPngBytes, '[file] Missing thumbnail bytes for save payload');
  }
  if (options.includeFlattenedImage) {
    ensureRequiredBytes(flattenedPngBytes, '[file] Missing flattened image bytes for save payload');
  }

  return {
    width: docStore.width,
    height: docStore.height,
    dpi: docStore.dpi,
    layers,
    flattenedPngBytes,
    thumbnailPngBytes,
  };
}

async function loadProjectIntoDocument(
  filePath: string,
  options: OpenPathOptions,
  set: (partial: Partial<FileState>) => void
): Promise<boolean> {
  set({ isLoading: true, error: null });

  try {
    const docStore = useDocumentStore.getState();
    docStore.reset();

    const ipcStart = performance.now();
    const projectData = await invoke<ProjectDataV2>('load_project_v2', { path: filePath });
    const ipcTransferMs = performance.now() - ipcStart;

    if (projectData.benchmark?.sessionId) {
      invoke('report_benchmark', {
        sessionId: projectData.benchmark.sessionId,
        phase: 'ipc_transfer',
        durationMs: ipcTransferMs,
      });
    }

    const loadedLayers = projectData.layers.map(layerDataV2ToLayer);
    const activeLayerId = loadedLayers[loadedLayers.length - 1]?.id ?? null;
    const detectedFormat = detectFileFormatFromPath(filePath) ?? 'ora';

    useDocumentStore.setState({
      width: projectData.width,
      height: projectData.height,
      dpi: projectData.dpi,
      layers: loadedLayers,
      activeLayerId,
      selectedLayerIds: activeLayerId ? [activeLayerId] : [],
      layerSelectionAnchorId: activeLayerId,
      filePath: options.asUntitled ? null : filePath,
      fileFormat: options.asUntitled ? null : detectedFormat,
      isDirty: false,
    });

    set({ isLoading: false });

    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const win = window as Window & {
      __loadLayerImages?: (
        layers: LayerImageLoadPayload[],
        benchmarkSessionId?: string
      ) => Promise<void>;
    };
    if (win.__loadLayerImages) {
      await win.__loadLayerImages(
        projectData.layers.map(layerV2ToLoadImagePayload),
        projectData.benchmark?.sessionId
      );
    }

    if (options.rememberAsLastSaved) {
      await updateSessionData((prev) => ({
        ...prev,
        lastSavedPath: filePath,
        hasUnsavedTemp: options.clearUnsavedTemp ? false : prev.hasUnsavedTemp,
      }));
    } else if (options.clearUnsavedTemp) {
      await updateSessionData((prev) => ({ ...prev, hasUnsavedTemp: false }));
    }

    if (!options.asUntitled && options.trackRecent) {
      useSettingsStore.getState().addRecentFile(filePath);
    }

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    set({ isLoading: false, error: errorMessage });
    if (!options.suppressErrorLog) {
      console.error('Open failed:', error);
    }

    if (options.trackRecent) {
      try {
        const stillExists = await exists(filePath);
        if (!stillExists) {
          useSettingsStore.getState().removeRecentFile(filePath);
        }
      } catch {
        // Keep recent entry when file existence cannot be verified.
      }
    }

    return false;
  }
}

async function saveProjectToTarget(
  targetPath: string,
  targetFormat: FileFormat,
  options: SaveTargetOptions,
  set: (partial: Partial<FileState>) => void
): Promise<SaveTargetResult> {
  set({ isSaving: true, error: null });

  try {
    const includeThumbnail = options.includeThumbnail ?? targetFormat === 'ora';
    const includeFlattenedImage = options.includeFlattenedImage ?? targetFormat === 'psd';
    const applySaveSuccess = () => {
      const docStore = useDocumentStore.getState();
      if (options.updateDocumentPath) {
        docStore.setFilePath(targetPath, targetFormat);
      }
      if (!options.updateDocumentPath && options.markDocumentClean) {
        docStore.setDirty(false);
      }
      set({ isSaving: false });
    };

    const projectDataV2 = await buildProjectDataSnapshotV2({
      includeThumbnail,
      includeFlattenedImage,
    });
    const v2Result = await invoke<FileOperationResult>('save_project_v2', {
      path: targetPath,
      format: targetFormat,
      project: projectDataV2,
    });
    if (!v2Result.success) {
      const message = v2Result.error || t('fileStore.error.unknownSaveError');
      set({ isSaving: false, error: message });
      return { success: false, error: message };
    }

    applySaveSuccess();
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    set({ isSaving: false, error: errorMessage });
    console.error('Save failed:', error);
    return { success: false, error: errorMessage };
  }
}

export const useFileStore = create<FileState>((set, get) => ({
  isSaving: false,
  isLoading: false,
  error: null,

  save: async (saveAs = false) => {
    const docStore = useDocumentStore.getState();
    const hadExistingPath = !!docStore.filePath;
    let targetPath = docStore.filePath;
    let targetFormat = docStore.fileFormat;

    // If no path or saveAs requested, show save dialog
    if (!targetPath || saveAs) {
      const result = await save({
        title: t('fileStore.dialog.saveProject.title'),
        filters: [
          { name: t('fileStore.dialog.filter.photoshop'), extensions: ['psd'] },
          { name: t('fileStore.dialog.filter.openRaster'), extensions: ['ora'] },
          // TIFF layer support disabled - see docs/postmortem/tiff-layer-support.md
        ],
        defaultPath: targetPath || t('fileStore.dialog.saveProject.defaultPath'),
      });

      if (!result) {
        return false; // User cancelled
      }

      const resolvedTarget = resolveSaveTarget(result);
      targetPath = resolvedTarget.path;
      targetFormat = resolvedTarget.format;
    }

    if (!targetPath || !targetFormat) return false;

    const saveResult = await saveProjectToTarget(
      targetPath,
      targetFormat,
      {
        updateDocumentPath: true,
        markDocumentClean: true,
      },
      set
    );

    if (!saveResult.success) {
      return false;
    }

    await updateSessionData((prev) => ({
      ...prev,
      lastSavedPath: targetPath,
      hasUnsavedTemp: false,
    }));

    if (!hadExistingPath) {
      try {
        const tempAutosavePath = await getTempAutosavePath();
        await invoke('delete_file_if_exists', { path: tempAutosavePath });
      } catch {
        // Temp file cleanup is best-effort.
      }
    }

    return true;
  },

  open: async () => {
    const result = await open({
      title: t('fileStore.dialog.openProject.title'),
      filters: [
        { name: t('fileStore.dialog.filter.allSupported'), extensions: ['ora', 'psd'] },
        { name: t('fileStore.dialog.filter.openRaster'), extensions: ['ora'] },
        { name: t('fileStore.dialog.filter.photoshop'), extensions: ['psd'] },
        // TIFF layer support disabled - see docs/postmortem/tiff-layer-support.md
      ],
      multiple: false,
    });

    if (!result) {
      return false; // User cancelled
    }

    const filePath = Array.isArray(result) ? result[0] : result;
    if (!filePath) return false;
    return get().openPath(filePath, {
      asUntitled: false,
      rememberAsLastSaved: true,
      clearUnsavedTemp: true,
    });
  },

  openPath: async (path: string, options?: OpenPathOptions) => {
    const openOptions = normalizeOpenPathOptions(options);
    return loadProjectIntoDocument(path, openOptions, set);
  },

  pruneMissingRecentFiles: async () => {
    const { recentFiles } = useSettingsStore.getState().general;
    if (recentFiles.length === 0) {
      return;
    }

    const checked = await Promise.all(
      recentFiles.map(async (recentPath) => {
        try {
          const fileExists = await exists(recentPath);
          return fileExists ? recentPath : null;
        } catch {
          // Keep entry when filesystem check is unavailable.
          return recentPath;
        }
      })
    );

    const nextRecentFiles = checked.filter((value): value is string => value !== null);
    if (hasSamePathOrder(nextRecentFiles, recentFiles)) {
      return;
    }

    useSettingsStore.getState().setRecentFiles(nextRecentFiles);
  },

  runAutoSaveTick: async () => {
    const fileState = get();
    if (fileState.isSaving || fileState.isLoading) return;

    const docStore = useDocumentStore.getState();
    if (!docStore.isDirty) return;

    const tempAutosavePath = await getTempAutosavePath();

    if (docStore.filePath) {
      const targetFormat =
        docStore.fileFormat ?? detectFileFormatFromPath(docStore.filePath) ?? 'ora';
      const primarySave = await saveProjectToTarget(
        docStore.filePath,
        targetFormat,
        AUTOSAVE_PRIMARY_TARGET_OPTIONS,
        set
      );

      if (primarySave.success) {
        await updateSessionData((prev) => ({
          ...prev,
          lastSavedPath: docStore.filePath,
          hasUnsavedTemp: false,
        }));
        return;
      }

      const fallbackSave = await saveProjectToTarget(
        tempAutosavePath,
        'ora',
        AUTOSAVE_TEMP_TARGET_OPTIONS,
        set
      );
      if (fallbackSave.success) {
        await updateSessionData((prev) => ({
          ...prev,
          hasUnsavedTemp: true,
          lastSavedPath: docStore.filePath,
        }));
      }
      return;
    }

    const tempSave = await saveProjectToTarget(
      tempAutosavePath,
      'ora',
      AUTOSAVE_TEMP_TARGET_OPTIONS,
      set
    );
    if (tempSave.success) {
      await updateSessionData((prev) => ({
        ...prev,
        hasUnsavedTemp: true,
      }));
    }
  },

  restoreOnStartup: async () => {
    await get().pruneMissingRecentFiles();

    const { openLastFileOnStartup } = useSettingsStore.getState().general;
    if (!openLastFileOnStartup) {
      return false;
    }

    const session = await readSessionData();

    if (session.hasUnsavedTemp) {
      const tempAutosavePath = await getTempAutosavePath();
      const restoredTemp = await get().openPath(tempAutosavePath, {
        asUntitled: true,
        rememberAsLastSaved: false,
        clearUnsavedTemp: false,
        suppressErrorLog: true,
      });
      if (restoredTemp) return true;
      await updateSessionData((prev) => ({ ...prev, hasUnsavedTemp: false }));
      try {
        await invoke('delete_file_if_exists', { path: tempAutosavePath });
      } catch {
        // Temp file cleanup is best-effort.
      }
    }

    if (session.lastSavedPath) {
      const restoredLast = await get().openPath(session.lastSavedPath, {
        asUntitled: false,
        rememberAsLastSaved: true,
        clearUnsavedTemp: true,
        suppressErrorLog: true,
      });
      if (restoredLast) return true;
    }

    return false;
  },

  reset: () => {
    set({
      isSaving: false,
      isLoading: false,
      error: null,
    });
  },
}));

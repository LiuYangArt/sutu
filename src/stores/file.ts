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

const SESSION_FILE = 'autosave-session.json';
const TEMP_AUTOSAVE_FILE_NAME = 'paintboard-autosave.ora';

// Types matching Rust backend
interface LayerData {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: string;
  isBackground?: boolean;
  imageData?: string;
  offsetX: number;
  offsetY: number;
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

interface ProjectData {
  width: number;
  height: number;
  dpi: number;
  layers: LayerData[];
  flattenedImage?: string;
  thumbnail?: string;
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
}

interface SaveTargetOptions {
  updateDocumentPath?: boolean;
  markDocumentClean?: boolean;
}

type CanvasExportWindow = Window & {
  __getThumbnail?: () => Promise<string | undefined>;
  __getFlattenedImage?: () => Promise<string | undefined>;
};

interface FileState {
  isSaving: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  save: (saveAs?: boolean) => Promise<boolean>;
  open: () => Promise<boolean>;
  openPath: (path: string, options?: OpenPathOptions) => Promise<boolean>;
  runAutoSaveTick: () => Promise<void>;
  restoreOnStartup: () => Promise<boolean>;
  reset: () => void;
}

const DEFAULT_SESSION: AutosaveSessionData = {
  lastSavedPath: null,
  hasUnsavedTemp: false,
};

/**
 * Get layer image data from canvas
 */
async function getLayerImageData(layerId: string): Promise<string | undefined> {
  const win = window as Window & {
    __getLayerImageData?: (layerId: string) => Promise<string | undefined>;
  };
  return win.__getLayerImageData?.(layerId);
}

/**
 * Get thumbnail image (256x256) for ORA
 */
async function getThumbnail(): Promise<string | undefined> {
  const win = window as CanvasExportWindow;
  return win.__getThumbnail?.();
}

/**
 * Get flattened composited image for PSD/TIFF exports
 */
async function getFlattenedImage(): Promise<string | undefined> {
  const win = window as CanvasExportWindow;
  return win.__getFlattenedImage?.();
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
    ...options,
  };
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

/**
 * Convert frontend Layer to backend LayerData format
 */
function layerToLayerData(layer: Layer, imageData?: string): LayerData {
  return {
    id: layer.id,
    name: layer.name,
    type: layer.type,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity / 100, // Convert 0-100 to 0.0-1.0
    blendMode: layer.blendMode,
    isBackground: layer.isBackground,
    imageData,
    offsetX: 0,
    offsetY: 0,
  };
}

/**
 * Convert backend LayerData to frontend Layer format
 */
function layerDataToLayer(data: LayerData): Layer {
  return {
    id: data.id,
    name: data.name,
    type: data.type as 'raster' | 'group' | 'adjustment',
    visible: data.visible,
    locked: data.locked,
    opacity: Math.round(data.opacity * 100), // Convert 0.0-1.0 to 0-100
    blendMode: data.blendMode as Layer['blendMode'],
    isBackground: data.isBackground,
    thumbnail: normalizeImageDataToDataUrl(data.imageData),
  };
}

async function buildProjectDataSnapshot(): Promise<ProjectData> {
  const docStore = useDocumentStore.getState();
  const layerDataPromises = docStore.layers.map(async (layer) => {
    const imageData = await getLayerImageData(layer.id);
    return layerToLayerData(layer, imageData);
  });

  const layers = await Promise.all(layerDataPromises);

  const [thumbnail, flattenedImage] = await Promise.all([getThumbnail(), getFlattenedImage()]);

  return {
    width: docStore.width,
    height: docStore.height,
    dpi: docStore.dpi,
    layers,
    flattenedImage,
    thumbnail,
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
    const projectData = await invoke<ProjectData>('load_project', { path: filePath });
    const ipcTransferMs = performance.now() - ipcStart;

    if (projectData.benchmark?.sessionId) {
      invoke('report_benchmark', {
        sessionId: projectData.benchmark.sessionId,
        phase: 'ipc_transfer',
        durationMs: ipcTransferMs,
      });
    }

    const loadedLayers = projectData.layers.map(layerDataToLayer);
    const detectedFormat = detectFileFormatFromPath(filePath) ?? 'ora';

    useDocumentStore.setState({
      width: projectData.width,
      height: projectData.height,
      dpi: projectData.dpi,
      layers: loadedLayers,
      activeLayerId: loadedLayers[loadedLayers.length - 1]?.id ?? null,
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
        layers: ProjectData['layers'],
        benchmarkSessionId?: string
      ) => Promise<void>;
    };
    if (win.__loadLayerImages) {
      await win.__loadLayerImages(projectData.layers, projectData.benchmark?.sessionId);
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

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    set({ isLoading: false, error: errorMessage });
    console.error('Open failed:', error);
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
    const projectData = await buildProjectDataSnapshot();
    const result = await invoke<FileOperationResult>('save_project', {
      path: targetPath,
      format: targetFormat,
      project: projectData,
    });

    if (!result.success) {
      const message = result.error || 'Unknown error';
      set({ isSaving: false, error: message });
      return { success: false, error: message };
    }

    const docStore = useDocumentStore.getState();
    if (options.updateDocumentPath) {
      docStore.setFilePath(targetPath, targetFormat);
    }
    if (!options.updateDocumentPath && options.markDocumentClean) {
      docStore.setDirty(false);
    }

    set({ isSaving: false });
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
        title: 'Save Project',
        filters: [
          { name: 'Photoshop', extensions: ['psd'] },
          { name: 'OpenRaster', extensions: ['ora'] },
          // TIFF layer support disabled - see docs/postmortem/tiff-layer-support.md
        ],
        defaultPath: targetPath || 'Untitled.psd',
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
      title: 'Open Project',
      filters: [
        { name: 'All Supported', extensions: ['ora', 'psd'] },
        { name: 'OpenRaster', extensions: ['ora'] },
        { name: 'Photoshop', extensions: ['psd'] },
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
        { updateDocumentPath: false, markDocumentClean: true },
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
        { updateDocumentPath: false, markDocumentClean: true },
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
      { updateDocumentPath: false, markDocumentClean: true },
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
      });
      if (restoredTemp) return true;
    }

    if (session.lastSavedPath) {
      const restoredLast = await get().openPath(session.lastSavedPath, {
        asUntitled: false,
        rememberAsLastSaved: true,
        clearUnsavedTemp: true,
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

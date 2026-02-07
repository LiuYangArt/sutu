/**
 * File operations store for save/load functionality
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { save, open } from '@tauri-apps/plugin-dialog';
import { useDocumentStore, FileFormat, Layer } from './document';

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

type CanvasExportWindow = Window & {
  __getThumbnail?: () => Promise<string | undefined>;
  __getFlattenedImage?: () => Promise<string | undefined>;
};

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

interface FileState {
  isSaving: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  save: (saveAs?: boolean) => Promise<boolean>;
  open: () => Promise<boolean>;
  reset: () => void;
}

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

export const useFileStore = create<FileState>((set) => ({
  isSaving: false,
  isLoading: false,
  error: null,

  save: async (saveAs = false) => {
    const docStore = useDocumentStore.getState();
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

    set({ isSaving: true, error: null });

    try {
      // Collect layer data with images
      const layerDataPromises = docStore.layers.map(async (layer) => {
        const imageData = await getLayerImageData(layer.id);
        return layerToLayerData(layer, imageData);
      });

      const layers = await Promise.all(layerDataPromises);

      // Export preview images from current composited canvas
      const [thumbnail, flattenedImage] = await Promise.all([getThumbnail(), getFlattenedImage()]);

      const projectData: ProjectData = {
        width: docStore.width,
        height: docStore.height,
        dpi: docStore.dpi,
        layers,
        flattenedImage,
        thumbnail,
      };

      const result = await invoke<FileOperationResult>('save_project', {
        path: targetPath,
        format: targetFormat,
        project: projectData,
      });

      if (result.success) {
        // Update document state
        docStore.setFilePath(targetPath!, targetFormat!);
        docStore.setDirty(false);
        set({ isSaving: false });
        return true;
      } else {
        set({ isSaving: false, error: result.error || 'Unknown error' });
        return false;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      set({ isSaving: false, error: errorMessage });
      console.error('Save failed:', error);
      return false;
    }
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

    set({ isLoading: true, error: null });

    try {
      const docStore = useDocumentStore.getState();

      // Reset current document state BEFORE loading new file
      // This ensures clean state and prevents conflicts with old layer data
      docStore.reset();

      // Measure IPC transfer time
      const ipcStart = performance.now();
      const projectData = await invoke<ProjectData>('load_project', {
        path: filePath,
      });
      const ipcTransferMs = performance.now() - ipcStart;

      // Report IPC transfer time to backend
      if (projectData.benchmark?.sessionId) {
        invoke('report_benchmark', {
          sessionId: projectData.benchmark.sessionId,
          phase: 'ipc_transfer',
          durationMs: ipcTransferMs,
        });
      }

      // Convert and set document state in one operation
      const loadedLayers = projectData.layers.map(layerDataToLayer);
      const format = detectFileFormatFromPath(filePath) ?? 'ora';

      useDocumentStore.setState({
        width: projectData.width,
        height: projectData.height,
        dpi: projectData.dpi,
        layers: loadedLayers,
        activeLayerId: loadedLayers[loadedLayers.length - 1]?.id ?? null,
        filePath,
        fileFormat: format,
        isDirty: false,
      });

      set({ isLoading: false });

      // Wait for Canvas to create layers before loading images
      // Use double requestAnimationFrame to ensure React has rendered and useEffect has run
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );

      // Small additional delay to ensure LayerRenderer has created layers
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // Trigger canvas reload with layer data, passing benchmark session ID
      const win = window as Window & {
        __loadLayerImages?: (
          layers: ProjectData['layers'],
          benchmarkSessionId?: string
        ) => Promise<void>;
      };
      if (win.__loadLayerImages) {
        await win.__loadLayerImages(projectData.layers, projectData.benchmark?.sessionId);
      }

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      set({ isLoading: false, error: errorMessage });
      console.error('Open failed:', error);
      return false;
    }
  },

  reset: () => {
    set({
      isSaving: false,
      isLoading: false,
      error: null,
    });
  },
}));

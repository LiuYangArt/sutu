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

interface ProjectData {
  width: number;
  height: number;
  dpi: number;
  layers: LayerData[];
  flattenedImage?: string;
  thumbnail?: string;
}

interface FileOperationResult {
  success: boolean;
  path?: string;
  error?: string;
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
  const win = window as Window & {
    __getThumbnail?: () => Promise<string | undefined>;
  };
  return win.__getThumbnail?.();
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
    thumbnail: data.imageData, // Use image data as thumbnail temporarily
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
          { name: 'OpenRaster', extensions: ['ora'] },
          { name: 'Photoshop', extensions: ['psd'] },
          // TIFF layer support disabled - see docs/postmortem/tiff-layer-support.md
        ],
        defaultPath: targetPath || 'Untitled.ora',
      });

      if (!result) {
        return false; // User cancelled
      }

      targetPath = result;
      // Detect format from extension
      if (result.toLowerCase().endsWith('.psd')) {
        targetFormat = 'psd';
      } else if (result.toLowerCase().endsWith('.ora')) {
        targetFormat = 'ora';
      } else {
        // Default to ORA if no recognized extension
        targetPath = result + '.ora';
        targetFormat = 'ora';
      }
    }

    set({ isSaving: true, error: null });

    try {
      // Collect layer data with images
      const layerDataPromises = docStore.layers.map(async (layer) => {
        const imageData = await getLayerImageData(layer.id);
        return layerToLayerData(layer, imageData);
      });

      const layers = await Promise.all(layerDataPromises);

      // Get thumbnail for ORA
      const thumbnail = await getThumbnail();

      const projectData: ProjectData = {
        width: docStore.width,
        height: docStore.height,
        dpi: docStore.dpi,
        layers,
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
      const projectData = await invoke<ProjectData>('load_project', {
        path: filePath,
      });

      const docStore = useDocumentStore.getState();

      // Detect format from path
      const format: FileFormat = filePath.toLowerCase().endsWith('.psd') ? 'psd' : 'ora';

      // Reset and initialize document with loaded data
      docStore.reset();

      // Initialize document dimensions
      docStore.initDocument({
        width: projectData.width,
        height: projectData.height,
        dpi: projectData.dpi,
      });

      // Clear default layer and add loaded layers
      // Note: initDocument creates a default layer, we need to handle this

      // Convert loaded layers
      const loadedLayers = projectData.layers.map(layerDataToLayer);

      // Replace layers directly using set
      useDocumentStore.setState({
        layers: loadedLayers,
        activeLayerId:
          loadedLayers.length > 0 ? (loadedLayers[loadedLayers.length - 1]?.id ?? null) : null,
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

      // Trigger canvas reload with layer data
      const win = window as Window & {
        __loadLayerImages?: (layers: ProjectData['layers']) => Promise<void>;
      };
      if (win.__loadLayerImages) {
        await win.__loadLayerImages(projectData.layers);
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

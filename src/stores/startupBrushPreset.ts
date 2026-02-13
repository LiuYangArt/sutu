import { useBrushLibraryStore } from '@/stores/brushLibrary';
import type { BrushPresetSelectionTool } from '@/stores/settings';
import { useToolStore } from '@/stores/tool';

function resolveActiveSelectionTool(): BrushPresetSelectionTool {
  return useToolStore.getState().currentTool === 'eraser' ? 'eraser' : 'brush';
}

export async function restoreStartupBrushPresetSelection(): Promise<void> {
  const brushLibraryStore = useBrushLibraryStore.getState();
  brushLibraryStore.hydrateSelectionFromSettings();

  const selectedPresetId =
    useBrushLibraryStore.getState().selectedPresetByTool[resolveActiveSelectionTool()];
  const libraryLoadPromise = brushLibraryStore.loadLibrary();
  if (!selectedPresetId) {
    return;
  }

  await libraryLoadPromise;
  useBrushLibraryStore.getState().applyPresetById(selectedPresetId);
}

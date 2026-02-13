import { useBrushLibraryStore } from '@/stores/brushLibrary';

export async function restoreStartupBrushPresetSelection(): Promise<void> {
  const brushLibraryStore = useBrushLibraryStore.getState();
  brushLibraryStore.hydrateSelectionFromSettings();
  await brushLibraryStore.loadLibrary();
}

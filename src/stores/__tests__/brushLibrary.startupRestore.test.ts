import { beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreStartupBrushPresetSelection } from '../startupBrushPreset';

const mocks = vi.hoisted(() => ({
  brushLibraryGetState: vi.fn(),
}));

vi.mock('@/stores/brushLibrary', () => ({
  useBrushLibraryStore: {
    getState: mocks.brushLibraryGetState,
  },
}));

type BrushSelectionByTool = {
  brush: string | null;
  eraser: string | null;
};

type MockBrushLibraryState = {
  selectedPresetByTool: BrushSelectionByTool;
  hydrateSelectionFromSettings: () => void;
  loadLibrary: () => Promise<void>;
  applyPresetById: (id: string) => void;
};

function createBrushLibraryState(
  selection: BrushSelectionByTool,
  overrides: Partial<MockBrushLibraryState> = {}
): MockBrushLibraryState {
  return {
    selectedPresetByTool: selection,
    hydrateSelectionFromSettings: vi.fn(),
    loadLibrary: vi.fn().mockResolvedValue(undefined),
    applyPresetById: vi.fn(),
    ...overrides,
  };
}

describe('brush library startup restore', () => {
  beforeEach(() => {
    mocks.brushLibraryGetState.mockReset();
  });

  it('hydrates preset selection from settings and loads library once', async () => {
    const state = createBrushLibraryState({ brush: null, eraser: null });
    mocks.brushLibraryGetState.mockReturnValue(state);

    await restoreStartupBrushPresetSelection();

    expect(state.hydrateSelectionFromSettings).toHaveBeenCalledTimes(1);
    expect(state.loadLibrary).toHaveBeenCalledTimes(1);
  });

  it('does not auto-apply selected brush preset on startup', async () => {
    const state = createBrushLibraryState({ brush: 'texture-tip-1', eraser: null });
    mocks.brushLibraryGetState.mockReturnValue(state);

    await restoreStartupBrushPresetSelection();

    expect(state.hydrateSelectionFromSettings).toHaveBeenCalledTimes(1);
    expect(state.loadLibrary).toHaveBeenCalledTimes(1);
    expect(state.applyPresetById).not.toHaveBeenCalled();
  });

  it('does not auto-apply selected eraser preset on startup', async () => {
    const state = createBrushLibraryState({ brush: null, eraser: 'eraser-tip-2' });
    mocks.brushLibraryGetState.mockReturnValue(state);

    await restoreStartupBrushPresetSelection();

    expect(state.hydrateSelectionFromSettings).toHaveBeenCalledTimes(1);
    expect(state.loadLibrary).toHaveBeenCalledTimes(1);
    expect(state.applyPresetById).not.toHaveBeenCalled();
  });
});

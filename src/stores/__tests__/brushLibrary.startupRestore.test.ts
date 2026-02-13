import { beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreStartupBrushPresetSelection } from '../startupBrushPreset';

const mocks = vi.hoisted(() => ({
  brushLibraryGetState: vi.fn(),
  toolGetState: vi.fn(),
}));

vi.mock('@/stores/brushLibrary', () => ({
  useBrushLibraryStore: {
    getState: mocks.brushLibraryGetState,
  },
}));

vi.mock('@/stores/tool', () => ({
  useToolStore: {
    getState: mocks.toolGetState,
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
    mocks.toolGetState.mockReset();
  });

  it('applies hydrated selection instead of stale initial snapshot', async () => {
    const staleState = createBrushLibraryState({ brush: null, eraser: null });
    const hydratedState = createBrushLibraryState({ brush: 'texture-tip-1', eraser: null });

    mocks.toolGetState.mockReturnValue({ currentTool: 'brush' });
    mocks.brushLibraryGetState
      .mockReturnValueOnce(staleState)
      .mockReturnValueOnce(hydratedState)
      .mockReturnValue(hydratedState);

    await restoreStartupBrushPresetSelection();

    expect(staleState.hydrateSelectionFromSettings).toHaveBeenCalledTimes(1);
    expect(staleState.loadLibrary).toHaveBeenCalledTimes(1);
    expect(hydratedState.applyPresetById).toHaveBeenCalledWith('texture-tip-1');
  });

  it('skips preset apply when active tool has no selected preset', async () => {
    const state = createBrushLibraryState({ brush: null, eraser: null });

    mocks.toolGetState.mockReturnValue({ currentTool: 'brush' });
    mocks.brushLibraryGetState.mockReturnValue(state);

    await restoreStartupBrushPresetSelection();

    expect(state.hydrateSelectionFromSettings).toHaveBeenCalledTimes(1);
    expect(state.loadLibrary).toHaveBeenCalledTimes(1);
    expect(state.applyPresetById).not.toHaveBeenCalled();
  });

  it('restores eraser preset when current tool is eraser', async () => {
    const state = createBrushLibraryState({ brush: null, eraser: 'eraser-tip-2' });

    mocks.toolGetState.mockReturnValue({ currentTool: 'eraser' });
    mocks.brushLibraryGetState.mockReturnValue(state);

    await restoreStartupBrushPresetSelection();

    expect(state.applyPresetById).toHaveBeenCalledWith('eraser-tip-2');
  });
});

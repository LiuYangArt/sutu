import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrushQuickPanel } from '../BrushQuickPanel';
import { useToolStore } from '@/stores/tool';
import { useBrushLibraryStore, type BrushLibraryPreset } from '@/stores/brushLibrary';
import { DEFAULT_ROUND_BRUSH } from '@/components/BrushPanel/types';

function createPreset(id: string, name: string, group: string | null): BrushLibraryPreset {
  return {
    ...DEFAULT_ROUND_BRUSH,
    id,
    name,
    tipId: null,
    group,
    source: 'test',
    contentHash: `hash-${id}`,
  };
}

function seedToolStore(): void {
  useToolStore.setState({
    currentTool: 'brush',
    brushSize: 32,
    eraserSize: 20,
    brushColor: '#112233',
    backgroundColor: '#ffffff',
  });
}

describe('BrushQuickPanel', () => {
  beforeEach(() => {
    seedToolStore();
  });

  it('filters presets with local search and applies selected preset', () => {
    const applyPresetById = vi.fn();
    const loadLibrary = vi.fn();

    useBrushLibraryStore.setState((state) => ({
      ...state,
      presets: [
        createPreset('soft-round', 'Soft Round', 'Basics'),
        createPreset('hard-chalk', 'Hard Chalk', 'Texture'),
      ],
      groups: [
        { name: 'Basics', presetIds: ['soft-round'] },
        { name: 'Texture', presetIds: ['hard-chalk'] },
      ],
      selectedPresetId: null,
      searchQuery: '',
      isLoading: false,
      error: null,
      applyPresetById,
      loadLibrary,
      clearError: vi.fn(),
    }));

    render(<BrushQuickPanel isOpen anchorX={120} anchorY={120} onRequestClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Soft Round/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hard Chalk/ })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search brushes...'), {
      target: { value: 'chalk' },
    });

    expect(screen.queryByRole('button', { name: /Soft Round/ })).not.toBeInTheDocument();
    const chalkButton = screen.getByRole('button', { name: /Hard Chalk/ });
    expect(chalkButton).toBeInTheDocument();

    fireEvent.click(chalkButton);
    expect(applyPresetById).toHaveBeenCalledWith('hard-chalk');
  });

  it('closes on Escape and outside pointerdown', () => {
    useBrushLibraryStore.setState((state) => ({
      ...state,
      presets: [createPreset('soft-round', 'Soft Round', 'Basics')],
      groups: [{ name: 'Basics', presetIds: ['soft-round'] }],
      selectedPresetId: null,
      searchQuery: '',
      isLoading: false,
      error: null,
      loadLibrary: vi.fn(),
      applyPresetById: vi.fn(),
      clearError: vi.fn(),
    }));

    const onRequestClose = vi.fn();
    render(<BrushQuickPanel isOpen anchorX={220} anchorY={180} onRequestClose={onRequestClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onRequestClose).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(document.body);
    expect(onRequestClose).toHaveBeenCalledTimes(2);
  });

  it('loads brush library when panel opens and local cache is empty', async () => {
    const loadLibrary = vi.fn().mockResolvedValue(undefined);
    useBrushLibraryStore.setState((state) => ({
      ...state,
      presets: [],
      groups: [],
      selectedPresetId: null,
      searchQuery: '',
      isLoading: false,
      error: null,
      loadLibrary,
      applyPresetById: vi.fn(),
      clearError: vi.fn(),
    }));

    render(<BrushQuickPanel isOpen anchorX={100} anchorY={100} onRequestClose={vi.fn()} />);

    await waitFor(() => {
      expect(loadLibrary).toHaveBeenCalledTimes(1);
    });
  });

  it('supports collapsing a brush group from group context menu', () => {
    useBrushLibraryStore.setState((state) => ({
      ...state,
      presets: [createPreset('soft-round', 'Soft Round', 'Basics')],
      groups: [{ name: 'Basics', presetIds: ['soft-round'] }],
      selectedPresetId: null,
      searchQuery: '',
      isLoading: false,
      error: null,
      loadLibrary: vi.fn(),
      applyPresetById: vi.fn(),
      clearError: vi.fn(),
    }));

    render(<BrushQuickPanel isOpen anchorX={100} anchorY={100} onRequestClose={vi.fn()} />);

    const groupTitle = screen.getByText('Basics');
    expect(screen.getByRole('button', { name: /Soft Round/ })).toBeInTheDocument();

    fireEvent.contextMenu(groupTitle);
    fireEvent.click(screen.getByRole('button', { name: /Collapse Group/ }));
    expect(screen.queryByRole('button', { name: /Soft Round/ })).not.toBeInTheDocument();

    fireEvent.contextMenu(groupTitle);
    expect(screen.getByRole('button', { name: /Expand Group/ })).toBeInTheDocument();
  });

  it('shows a visible group toggle button and collapses from title row', () => {
    useBrushLibraryStore.setState((state) => ({
      ...state,
      presets: [createPreset('soft-round', 'Soft Round', 'Basics')],
      groups: [{ name: 'Basics', presetIds: ['soft-round'] }],
      selectedPresetId: null,
      searchQuery: '',
      isLoading: false,
      error: null,
      loadLibrary: vi.fn(),
      applyPresetById: vi.fn(),
      clearError: vi.fn(),
    }));

    render(<BrushQuickPanel isOpen anchorX={100} anchorY={100} onRequestClose={vi.fn()} />);

    const collapseBtn = screen.getByRole('button', { name: /Collapse group Basics/i });
    expect(collapseBtn).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Soft Round/ })).toBeInTheDocument();

    fireEvent.click(collapseBtn);
    expect(screen.queryByRole('button', { name: /Soft Round/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Expand group Basics/i })).toBeInTheDocument();
  });
});

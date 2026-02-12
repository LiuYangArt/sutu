import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TextureSettings } from './TextureSettings';
import { useToolStore } from '@/stores/tool';
import { usePatternLibraryStore } from '@/stores/pattern';
import { useToastStore } from '@/stores/toast';
import { DEFAULT_TEXTURE_SETTINGS } from '../types';

const patternManagerMocks = vi.hoisted(() => ({
  loadPattern: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./PatternPicker', () => ({
  PatternPicker: ({ selectedId }: { selectedId: string | null }) => (
    <div data-testid="pattern-picker">{selectedId ?? 'none'}</div>
  ),
}));

vi.mock('@/utils/patternManager', () => ({
  patternManager: {
    loadPattern: patternManagerMocks.loadPattern,
  },
}));

describe('TextureSettings', () => {
  beforeEach(() => {
    patternManagerMocks.loadPattern.mockClear();

    useToolStore.setState({
      textureEnabled: true,
      textureSettings: { ...DEFAULT_TEXTURE_SETTINGS, patternId: 'brush-pattern-1', invert: false },
      patterns: [
        {
          id: 'brush-pattern-1',
          name: 'Brush Pattern One',
          width: 64,
          height: 64,
          mode: 'RGB',
        },
      ],
    });

    usePatternLibraryStore.setState({
      patterns: [],
      isLoading: false,
      error: null,
      searchQuery: '',
      addPatternFromBrush: vi.fn(),
    });

    useToastStore.setState({ toasts: [] });
  });

  it('renders Pattern picker + top Invert and removes duplicate preview/invert UI', () => {
    render(<TextureSettings />);

    expect(screen.getByTestId('pattern-picker')).toBeInTheDocument();
    expect(screen.getAllByText('Invert')).toHaveLength(1);
    expect(screen.queryByTitle('Hover for preview')).not.toBeInTheDocument();
    expect(screen.queryByText('Pattern Preview')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add pattern to library' })).toBeEnabled();
  });

  it('disables add button when selected pattern already exists in library', () => {
    usePatternLibraryStore.setState({
      patterns: [
        {
          id: 'brush-pattern-1',
          name: 'Already in Library',
          contentHash: 'hash-exist',
          width: 64,
          height: 64,
          mode: 'RGB',
          source: 'user-added',
          group: null,
        },
      ],
    });

    render(<TextureSettings />);

    expect(screen.getByRole('button', { name: 'Add pattern to library' })).toBeDisabled();
  });

  it('clicking add button switches to resolved library pattern and shows duplicate toast', async () => {
    const addPatternFromBrush = vi.fn().mockResolvedValue({
      added: false,
      pattern: {
        id: 'library-pattern-9',
        name: 'Library Item',
        contentHash: 'hash-9',
        width: 64,
        height: 64,
        mode: 'RGB',
        source: 'user-added',
        group: null,
      },
    });

    usePatternLibraryStore.setState({ addPatternFromBrush });
    render(<TextureSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Add pattern to library' }));

    await waitFor(() => {
      expect(addPatternFromBrush).toHaveBeenCalledWith('brush-pattern-1', 'Brush Pattern One');
    });

    expect(useToolStore.getState().textureSettings.patternId).toBe('library-pattern-9');
    const toasts = useToastStore.getState().toasts;
    expect(toasts[toasts.length - 1]?.message).toBe(
      'Pattern already exists, switched to existing item'
    );
  });
});

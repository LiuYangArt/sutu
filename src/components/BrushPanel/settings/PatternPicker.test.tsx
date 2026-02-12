import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PatternPicker } from './PatternPicker';
import { usePatternLibraryStore } from '@/stores/pattern';

const patternManagerMocks = vi.hoisted(() => ({
  loadPattern: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils/patternManager', () => ({
  patternManager: {
    loadPattern: patternManagerMocks.loadPattern,
  },
}));

vi.mock('@/components/common/LZ4Image', () => ({
  LZ4Image: ({ alt }: { alt?: string }) => <div data-testid="mock-lz4">{alt ?? ''}</div>,
}));

describe('PatternPicker', () => {
  beforeEach(() => {
    patternManagerMocks.loadPattern.mockClear();
    usePatternLibraryStore.setState({
      patterns: [],
      isLoading: false,
      error: null,
      searchQuery: '',
      loadPatterns: async () => {},
    });
  });

  it('selected pattern missing in library still shows fallback and appears in dropdown bottom row', () => {
    const onSelect = vi.fn();
    usePatternLibraryStore.setState({
      patterns: [
        {
          id: 'lib-1',
          name: 'Library Pattern',
          contentHash: 'hash-1',
          width: 32,
          height: 32,
          mode: 'RGB',
          source: 'user-added',
          group: null,
        },
      ],
    });

    render(
      <PatternPicker
        selectedId="brush-1"
        onSelect={onSelect}
        fallbackPattern={{ id: 'brush-1', name: 'Brush Fallback', width: 64, height: 64 }}
      />
    );

    expect(screen.getAllByText('Brush Fallback').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /brush fallback/i }));
    expect(screen.getByText('Current Brush Pattern')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Brush Fallback (64×64)'));
    expect(onSelect).toHaveBeenCalledWith('brush-1');
    expect(patternManagerMocks.loadPattern).toHaveBeenCalledWith('brush-1');
  });

  it('trigger keeps showing selected library item even when filtered list does not include it', () => {
    usePatternLibraryStore.setState({
      patterns: [
        {
          id: 'lib-2',
          name: 'Stone',
          contentHash: 'hash-2',
          width: 32,
          height: 32,
          mode: 'RGB',
          source: 'user-added',
          group: null,
        },
      ],
      searchQuery: 'not-match',
    });

    render(<PatternPicker selectedId="lib-2" onSelect={() => {}} />);

    expect(screen.getAllByText('Stone').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /stone/i }));
    expect(screen.queryByText('Current Brush Pattern')).not.toBeInTheDocument();
  });
});

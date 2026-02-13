import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrushSettingsSidebar } from './BrushSettingsSidebar';
import { useToolStore } from '@/stores/tool';
import { usePatternLibraryStore } from '@/stores/pattern';
import { DEFAULT_TEXTURE_SETTINGS } from './types';

function createPattern(id: string, name: string) {
  return {
    id,
    name,
    contentHash: `hash-${id}`,
    width: 64,
    height: 64,
    mode: 'RGB' as const,
    source: 'user-added',
    group: null,
  };
}

describe('BrushSettingsSidebar texture toggle behavior', () => {
  beforeEach(() => {
    useToolStore.setState({
      textureEnabled: false,
      textureSettings: { ...DEFAULT_TEXTURE_SETTINGS, patternId: null },
    });
  });

  it('enables texture and picks first pattern immediately when library is already available', async () => {
    const loadPatterns = vi.fn(async () => {});
    usePatternLibraryStore.setState({
      patterns: [createPattern('library-pattern-1', 'Library Pattern 1')],
      loadPatterns,
    });

    render(
      <BrushSettingsSidebar
        tabs={[{ id: 'texture', label: 'Texture' }]}
        activeTabId="texture"
        onTabSelect={() => {}}
        onSave={() => {}}
        onSaveAs={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => {
      expect(useToolStore.getState().textureEnabled).toBe(true);
      expect(useToolStore.getState().textureSettings.patternId).toBe('library-pattern-1');
    });
    expect(loadPatterns).not.toHaveBeenCalled();
  });

  it('loads library and then picks first pattern when toggling texture with empty local cache', async () => {
    const loadPatterns = vi.fn(async () => {
      usePatternLibraryStore.setState({
        patterns: [createPattern('library-pattern-2', 'Library Pattern 2')],
      });
    });
    usePatternLibraryStore.setState({
      patterns: [],
      loadPatterns,
    });

    render(
      <BrushSettingsSidebar
        tabs={[{ id: 'texture', label: 'Texture' }]}
        activeTabId="texture"
        onTabSelect={() => {}}
        onSave={() => {}}
        onSaveAs={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => {
      expect(useToolStore.getState().textureEnabled).toBe(true);
      expect(useToolStore.getState().textureSettings.patternId).toBe('library-pattern-2');
    });
    expect(loadPatterns).toHaveBeenCalledTimes(1);
  });
});

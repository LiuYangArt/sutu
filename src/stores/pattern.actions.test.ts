import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: coreMocks.invoke,
}));

import { PatternResource, usePatternLibraryStore } from './pattern';

function createPattern(id: string, name: string): PatternResource {
  return {
    id,
    name,
    contentHash: `hash-${id}`,
    width: 32,
    height: 32,
    mode: 'RGB',
    source: 'user-added',
    group: null,
  };
}

describe('pattern store addPatternFromBrush', () => {
  beforeEach(() => {
    coreMocks.invoke.mockReset();
    usePatternLibraryStore.setState({
      patterns: [],
      isLoading: false,
      error: null,
      searchQuery: '',
    });
  });

  it('adds returned pattern to local store without full reload', async () => {
    const result = {
      added: true,
      pattern: createPattern('lib-a', 'New Pattern'),
    };
    coreMocks.invoke.mockResolvedValue(result);

    const response = await usePatternLibraryStore
      .getState()
      .addPatternFromBrush('brush-a', 'New Pattern');

    expect(coreMocks.invoke).toHaveBeenCalledWith('add_pattern_from_brush', {
      patternId: 'brush-a',
      name: 'New Pattern',
    });
    expect(response).toEqual(result);
    expect(usePatternLibraryStore.getState().patterns).toEqual([result.pattern]);
  });

  it('upserts existing id when duplicate path returns existing library pattern', async () => {
    usePatternLibraryStore.setState({
      patterns: [createPattern('lib-a', 'Old Name')],
    });

    const result = {
      added: false,
      pattern: createPattern('lib-a', 'Updated Name'),
    };
    coreMocks.invoke.mockResolvedValue(result);

    await usePatternLibraryStore.getState().addPatternFromBrush('brush-a', 'Updated Name');

    const patterns = usePatternLibraryStore.getState().patterns;
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.id).toBe('lib-a');
    expect(patterns[0]?.name).toBe('Updated Name');
  });
});

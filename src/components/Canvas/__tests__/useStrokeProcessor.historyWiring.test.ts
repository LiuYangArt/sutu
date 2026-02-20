import { describe, expect, it } from 'vitest';
import strokeProcessorSource from '../useStrokeProcessor.ts?raw';

describe('useStrokeProcessor history wiring', () => {
  it('discards captured history when gpu commit returns uncommitted result', () => {
    expect(strokeProcessorSource).toContain('const commitResult = await commitStrokeGpu();');
    expect(strokeProcessorSource).toContain('persistHistoryEntry = commitResult.committed;');
    expect(strokeProcessorSource).toContain('discardCapturedStrokeHistory();');
  });
});

import { describe, expect, it } from 'vitest';
import rendererSource from './GpuCanvasRenderer.ts?raw';

describe('GpuCanvasRenderer selection fill commit path', () => {
  it('commits selection fill through tile-based dirty rect traversal', () => {
    expect(rendererSource).toMatch(/commitSelectionFill\(params: CommitSelectionFillParams\)/);
    expect(rendererSource).toContain('const fillDirtyRect = fill.dirtyRect ?? {');
    expect(rendererSource).toContain('const tiles = this.getTilesForRect(fillDirtyRect);');
  });

  it('preserves outside-dirty pixels during partial-tile selection fill commits', () => {
    const preservePattern =
      /const preserveOutsideDirtyRegion = !this\.isFullTileDraw\(drawRegion, rect\);[\s\S]*loadExistingTarget: preserveOutsideDirtyRegion,/;
    expect(rendererSource).toMatch(preservePattern);
  });
});

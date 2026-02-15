import { describe, expect, it } from 'vitest';
import canvasSource from '../index.tsx?raw';

function getSelectionAutoFillGpuCommitBlock(source: string): string {
  const match = source.match(
    /const commitSelectionFillGpu = useCallback\([\s\S]*?\n\s*commitSelectionFillGpuRef\.current = commitSelectionFillGpu;/
  );
  return match?.[0] ?? '';
}

describe('selection auto-fill gpu wiring', () => {
  it('uses committed selection snapshot mask before gpu fill commit', () => {
    const block = getSelectionAutoFillGpuCommitBlock(canvasSource);
    expect(block).toContain('gpuRenderer.setSelectionMask(params.selectionMask);');
  });

  it('forces immediate gpu->cpu tile sync after selection fill commit', () => {
    const block = getSelectionAutoFillGpuCommitBlock(canvasSource);
    expect(block).toContain(
      'const synced = await syncGpuLayerTilesToCpu(params.layerId, committedTiles);'
    );
    expect(block).toContain("return fail('readback sync failed after commit'");
  });

  it('does not defer selection fill sync via pending tile scheduler', () => {
    const block = getSelectionAutoFillGpuCommitBlock(canvasSource);
    expect(block).not.toContain('trackPendingGpuCpuSyncTiles(params.layerId, committedTiles)');
    expect(block).not.toContain('schedulePendingGpuCpuSync(params.layerId)');
  });
});

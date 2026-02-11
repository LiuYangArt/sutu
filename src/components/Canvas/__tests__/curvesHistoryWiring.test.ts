import { describe, expect, it } from 'vitest';
import canvasSource from '../index.tsx?raw';

describe('curves/gradient history wiring', () => {
  it('pushes cpu snapshot from curves session baseline for gpu commit', () => {
    const curvesBackupPattern =
      /const commitCurvesGpu =[\s\S]*useHistoryStore\.getState\(\)\.pushStroke\(\{[\s\S]*snapshotMode:\s*'cpu'[\s\S]*beforeImage:\s*cloneCurvesSessionImageData\(session\.baseImageData\)/;
    expect(canvasSource).toMatch(curvesBackupPattern);
  });

  it('pushes cpu snapshot from curves session baseline for cpu commit', () => {
    const curvesCpuCommitPattern =
      /const commitCurvesSession =[\s\S]*useHistoryStore\.getState\(\)\.pushStroke\(\{[\s\S]*snapshotMode:\s*'cpu'[\s\S]*beforeImage:\s*cloneCurvesSessionImageData\(session\.baseImageData\)/;
    expect(canvasSource).toMatch(curvesCpuCommitPattern);
  });

  it('uses captured stroke history meta for gradient gpu commit', () => {
    const gradientCommitPattern =
      /const commitGradientGpu =[\s\S]*const capturedHistoryMeta = getCapturedStrokeHistoryMeta\(\);[\s\S]*capturedHistoryMeta\.snapshotMode === 'gpu'/;
    expect(canvasSource).toMatch(gradientCommitPattern);
  });

  it('captures cpu backup snapshot while preparing gradient gpu commit history', () => {
    const gradientBackupPattern =
      /const commitGradientGpu =[\s\S]*await captureBeforeImage\(true, true\);/;
    expect(canvasSource).toMatch(gradientBackupPattern);
  });
});

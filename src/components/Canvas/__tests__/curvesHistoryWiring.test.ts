import { describe, expect, it } from 'vitest';
import canvasSource from '../index.tsx?raw';

describe('curves/gradient history wiring', () => {
  it('uses captured stroke history meta for curves gpu commit', () => {
    const curvesCommitPattern =
      /const commitCurvesGpu =[\s\S]*const capturedHistoryMeta = getCapturedStrokeHistoryMeta\(\);[\s\S]*capturedHistoryMeta\.snapshotMode === 'gpu'/;
    expect(canvasSource).toMatch(curvesCommitPattern);
  });

  it('captures cpu backup snapshot while preparing curves gpu commit history', () => {
    const curvesBackupPattern =
      /const commitCurvesGpu =[\s\S]*await captureBeforeImage\(true, true\);/;
    expect(canvasSource).toMatch(curvesBackupPattern);
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

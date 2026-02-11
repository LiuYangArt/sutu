import { describe, expect, it } from 'vitest';
import rendererSource from './GpuCanvasRenderer.ts?raw';

describe('GpuCanvasRenderer preview dirty-region preservation', () => {
  it('preserves outside-dirty pixels for gradient preview', () => {
    const gradientBranchPattern =
      /if \(gradientPreview\)[\s\S]*const preserveOutsideDirtyRegion = !this\.isFullTileDraw\(previewDrawRegion, rect\);[\s\S]*loadExistingTarget: preserveOutsideDirtyRegion,/;
    expect(rendererSource).toMatch(gradientBranchPattern);
  });

  it('preserves outside-dirty pixels for curves preview', () => {
    const curvesBranchPattern =
      /if \(curvesPreview\)[\s\S]*const preserveOutsideDirtyRegion = !this\.isFullTileDraw\(previewDrawRegion, rect\);[\s\S]*loadExistingTarget: preserveOutsideDirtyRegion,/;
    expect(rendererSource).toMatch(curvesBranchPattern);
  });
});

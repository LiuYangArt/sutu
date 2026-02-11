import { describe, expect, it } from 'vitest';
import {
  bumpLayerRevisions,
  isGpuCurvesPathAvailable,
  isGpuHistoryPathAvailable,
  isGpuLayerBlendModeM3,
  isGpuLayerStackPathAvailable,
  reconcileLayerRevisionMap,
} from '../gpuLayerStackPolicy';

describe('gpuLayerStackPolicy', () => {
  it('allows GPU stack path when backend and visible blend are supported', () => {
    const allowed = isGpuLayerStackPathAvailable({
      brushBackend: 'gpu',
      gpuAvailable: true,
      currentTool: 'brush',
      layers: [
        { visible: true, blendMode: 'normal' },
        { visible: true, blendMode: 'multiply' },
      ],
    });
    expect(allowed).toBe(true);
  });

  it('keeps GPU stack path enabled for non-brush tools to avoid display-path color shifts', () => {
    const allowed = isGpuLayerStackPathAvailable({
      brushBackend: 'gpu',
      gpuAvailable: true,
      currentTool: 'select',
      layers: [
        { visible: true, blendMode: 'normal' },
        { visible: true, blendMode: 'luminosity' },
      ],
    });
    expect(allowed).toBe(true);
  });

  it('allows GPU stack path for full blend-mode set', () => {
    const allowed = isGpuLayerStackPathAvailable({
      brushBackend: 'gpu',
      gpuAvailable: true,
      currentTool: 'zoom',
      layers: [
        { visible: true, blendMode: 'normal' },
        { visible: true, blendMode: 'difference' },
      ],
    });
    expect(allowed).toBe(true);
  });

  it('ignores unsupported blend mode on hidden layers', () => {
    const allowed = isGpuLayerStackPathAvailable({
      brushBackend: 'gpu',
      gpuAvailable: true,
      currentTool: 'eyedropper',
      layers: [
        { visible: true, blendMode: 'screen' },
        { visible: false, blendMode: 'difference' },
      ],
    });
    expect(allowed).toBe(true);
  });

  it('rejects GPU stack path when there is no visible layer', () => {
    const allowed = isGpuLayerStackPathAvailable({
      brushBackend: 'gpu',
      gpuAvailable: true,
      currentTool: 'brush',
      layers: [{ visible: false, blendMode: 'normal' }],
    });
    expect(allowed).toBe(false);
  });

  it('allows curves GPU path when GPU is available and visible blend modes are supported', () => {
    const allowed = isGpuCurvesPathAvailable({
      gpuAvailable: true,
      layers: [
        { visible: true, blendMode: 'normal' },
        { visible: true, blendMode: 'multiply' },
      ],
    });
    expect(allowed).toBe(true);
  });

  it('rejects curves GPU path when visible blend mode is unsupported', () => {
    const allowed = isGpuCurvesPathAvailable({
      gpuAvailable: true,
      layers: [
        { visible: true, blendMode: 'normal' },
        { visible: true, blendMode: 'unsupported-mode' as never },
      ],
    });
    expect(allowed).toBe(false);
  });

  it('rejects curves GPU path when no visible layer exists', () => {
    const allowed = isGpuCurvesPathAvailable({
      gpuAvailable: true,
      layers: [{ visible: false, blendMode: 'normal' }],
    });
    expect(allowed).toBe(false);
  });

  it('exposes M3 blend whitelist', () => {
    expect(isGpuLayerBlendModeM3('normal')).toBe(true);
    expect(isGpuLayerBlendModeM3('dissolve')).toBe(true);
    expect(isGpuLayerBlendModeM3('overlay')).toBe(true);
    expect(isGpuLayerBlendModeM3('linear-light')).toBe(true);
    expect(isGpuLayerBlendModeM3('difference')).toBe(true);
    expect(isGpuLayerBlendModeM3('luminosity')).toBe(true);
  });

  it('bumps only dirty layer revisions when dirty list is provided', () => {
    const base = new Map<string, number>([
      ['a', 1],
      ['b', 3],
      ['c', 0],
    ]);
    const next = bumpLayerRevisions({
      current: base,
      allLayerIds: ['a', 'b', 'c'],
      dirtyLayerIds: ['b'],
    });
    expect(next.get('a')).toBe(1);
    expect(next.get('b')).toBe(4);
    expect(next.get('c')).toBe(0);
  });

  it('bumps all revisions when dirty list is omitted', () => {
    const base = new Map<string, number>([
      ['a', 0],
      ['b', 2],
    ]);
    const next = bumpLayerRevisions({
      current: base,
      allLayerIds: ['a', 'b'],
    });
    expect(next.get('a')).toBe(1);
    expect(next.get('b')).toBe(3);
  });

  it('reconciles revision map to current layer ids', () => {
    const base = new Map<string, number>([
      ['a', 2],
      ['legacy', 7],
    ]);
    const next = reconcileLayerRevisionMap(base, ['a', 'b']);
    expect(next.get('a')).toBe(2);
    expect(next.get('b')).toBe(0);
    expect(next.has('legacy')).toBe(false);
  });

  it('enables gpu history on gpu display brush-like and gradient path', () => {
    expect(
      isGpuHistoryPathAvailable({
        gpuDisplayActive: true,
        currentTool: 'brush',
      })
    ).toBe(true);
    expect(
      isGpuHistoryPathAvailable({
        gpuDisplayActive: true,
        currentTool: 'eraser',
      })
    ).toBe(true);
    expect(
      isGpuHistoryPathAvailable({
        gpuDisplayActive: true,
        currentTool: 'gradient',
      })
    ).toBe(true);
  });

  it('disables gpu history when gpu display is inactive or tool is not brush-like', () => {
    expect(
      isGpuHistoryPathAvailable({
        gpuDisplayActive: false,
        currentTool: 'brush',
      })
    ).toBe(false);

    expect(
      isGpuHistoryPathAvailable({
        gpuDisplayActive: true,
        currentTool: 'zoom',
      })
    ).toBe(false);
  });
});

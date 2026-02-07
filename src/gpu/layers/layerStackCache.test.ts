import { describe, expect, it } from 'vitest';
import { buildBelowCacheSignature } from './layerStackCache';
import type { GpuRenderableLayer } from '../types';

function makeLayer(
  overrides: Partial<GpuRenderableLayer> & Pick<GpuRenderableLayer, 'id'>
): GpuRenderableLayer {
  return {
    id: overrides.id,
    visible: overrides.visible ?? true,
    opacity: overrides.opacity ?? 100,
    blendMode: overrides.blendMode ?? 'normal',
    revision: overrides.revision ?? 0,
  };
}

describe('buildBelowCacheSignature', () => {
  it('changes when active layer changes', () => {
    const layers = [makeLayer({ id: 'a' })];
    const generation = new Map<string, number>([['a', 0]]);

    const sigA = buildBelowCacheSignature({
      activeLayerId: 'active-a',
      belowLayers: layers,
      getContentGeneration: (layerId) => generation.get(layerId) ?? 0,
    });
    const sigB = buildBelowCacheSignature({
      activeLayerId: 'active-b',
      belowLayers: layers,
      getContentGeneration: (layerId) => generation.get(layerId) ?? 0,
    });

    expect(sigA).not.toBe(sigB);
  });

  it('changes when below layer order/opacity/blend/revision changes', () => {
    const base = [
      makeLayer({ id: 'a', opacity: 100, blendMode: 'normal', revision: 1 }),
      makeLayer({ id: 'b', opacity: 80, blendMode: 'multiply', revision: 2 }),
    ];
    const generation = new Map<string, number>([
      ['a', 0],
      ['b', 0],
    ]);

    const original = buildBelowCacheSignature({
      activeLayerId: 'active',
      belowLayers: base,
      getContentGeneration: (layerId) => generation.get(layerId) ?? 0,
    });

    const reordered = buildBelowCacheSignature({
      activeLayerId: 'active',
      belowLayers: [base[1]!, base[0]!],
      getContentGeneration: (layerId) => generation.get(layerId) ?? 0,
    });
    expect(original).not.toBe(reordered);

    const changedOpacity = buildBelowCacheSignature({
      activeLayerId: 'active',
      belowLayers: [makeLayer({ ...base[0]!, opacity: 50 }), base[1]!],
      getContentGeneration: (layerId) => generation.get(layerId) ?? 0,
    });
    expect(original).not.toBe(changedOpacity);

    const changedBlend = buildBelowCacheSignature({
      activeLayerId: 'active',
      belowLayers: [base[0]!, makeLayer({ ...base[1]!, blendMode: 'screen' })],
      getContentGeneration: (layerId) => generation.get(layerId) ?? 0,
    });
    expect(original).not.toBe(changedBlend);

    const changedRevision = buildBelowCacheSignature({
      activeLayerId: 'active',
      belowLayers: [base[0]!, makeLayer({ ...base[1]!, revision: 3 })],
      getContentGeneration: (layerId) => generation.get(layerId) ?? 0,
    });
    expect(original).not.toBe(changedRevision);
  });

  it('changes when content generation changes', () => {
    const layers = [makeLayer({ id: 'a', revision: 1 })];
    const generation = new Map<string, number>([['a', 0]]);

    const before = buildBelowCacheSignature({
      activeLayerId: 'active',
      belowLayers: layers,
      getContentGeneration: (layerId) => generation.get(layerId) ?? 0,
    });

    generation.set('a', 1);
    const after = buildBelowCacheSignature({
      activeLayerId: 'active',
      belowLayers: layers,
      getContentGeneration: (layerId) => generation.get(layerId) ?? 0,
    });

    expect(before).not.toBe(after);
  });
});

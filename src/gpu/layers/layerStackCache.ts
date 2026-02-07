import type { GpuRenderableLayer } from '../types';

export function buildBelowCacheSignature(args: {
  activeLayerId: string | null;
  belowLayers: GpuRenderableLayer[];
  getContentGeneration: (layerId: string) => number;
}): string {
  const { activeLayerId, belowLayers, getContentGeneration } = args;
  const below = belowLayers
    .map(
      (layer) =>
        `${layer.id}:${layer.revision}:${getContentGeneration(layer.id)}:${layer.opacity}:${layer.blendMode}`
    )
    .join('|');
  return `${activeLayerId ?? 'none'}|${below}`;
}

import type { ToolType } from '@/stores/tool';
import type { BlendMode } from '@/stores/document';
import type { GpuLayerBlendModeM3 } from '@/gpu';

const GPU_STACK_TOOLS = new Set<ToolType>(['brush', 'zoom', 'eyedropper']);

const GPU_LAYER_BLEND_MODE_M3: readonly GpuLayerBlendModeM3[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
];

const GPU_LAYER_BLEND_MODE_M3_SET = new Set<BlendMode>(GPU_LAYER_BLEND_MODE_M3);

export interface GpuLayerStackGateLayer {
  visible: boolean;
  blendMode: BlendMode;
}

export function isGpuLayerBlendModeM3(blendMode: BlendMode): blendMode is GpuLayerBlendModeM3 {
  return GPU_LAYER_BLEND_MODE_M3_SET.has(blendMode);
}

export function isGpuLayerStackPathAvailable(args: {
  brushBackend: string;
  gpuAvailable: boolean;
  currentTool: ToolType | null;
  layers: GpuLayerStackGateLayer[];
}): boolean {
  const { brushBackend, gpuAvailable, currentTool, layers } = args;
  if (
    brushBackend !== 'gpu' ||
    !gpuAvailable ||
    !currentTool ||
    !GPU_STACK_TOOLS.has(currentTool)
  ) {
    return false;
  }

  const visibleLayers = layers.filter((layer) => layer.visible);
  if (visibleLayers.length === 0) {
    return false;
  }

  return visibleLayers.every((layer) => isGpuLayerBlendModeM3(layer.blendMode));
}

export function isGpuHistoryPathAvailable(args: {
  gpuDisplayActive: boolean;
  currentTool: ToolType | null;
}): boolean {
  const { gpuDisplayActive, currentTool } = args;
  return gpuDisplayActive && currentTool === 'brush';
}

export function reconcileLayerRevisionMap(
  current: ReadonlyMap<string, number>,
  layerIds: readonly string[]
): Map<string, number> {
  const next = new Map<string, number>();
  for (const layerId of layerIds) {
    next.set(layerId, current.get(layerId) ?? 0);
  }
  return next;
}

export function bumpLayerRevisions(args: {
  current: ReadonlyMap<string, number>;
  allLayerIds: readonly string[];
  dirtyLayerIds?: readonly string[] | undefined;
}): Map<string, number> {
  const { current, allLayerIds, dirtyLayerIds } = args;
  const next = new Map(current);
  const targetIds =
    dirtyLayerIds && dirtyLayerIds.length > 0 ? dirtyLayerIds : (allLayerIds as readonly string[]);

  for (const layerId of targetIds) {
    next.set(layerId, (next.get(layerId) ?? 0) + 1);
  }
  return next;
}

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useToolStore } from '@/stores/tool';
import { prewarmBrushTextures } from '@/utils/brushLoader';
import {
  useSettingsStore,
  type BrushPresetSelectionByTool,
  type BrushPresetSelectionTool,
} from '@/stores/settings';
import type { BrushPreset, DualBrushSettingsPreset } from '@/components/BrushPanel/types';
import { applyPresetToToolStore } from '@/components/BrushPanel/settings/BrushPresets';

export type { BrushPresetSelectionByTool, BrushPresetSelectionTool } from '@/stores/settings';

export interface BrushTipResource extends BrushPreset {
  source: string;
  contentHash: string;
}

export interface BrushLibraryPreset extends BrushPreset {
  tipId: string | null;
  group: string | null;
  source: string;
  contentHash: string;
}

export interface BrushLibraryGroup {
  name: string;
  presetIds: string[];
}

interface BrushLibrarySnapshot {
  presets: BrushLibraryPreset[];
  tips: BrushTipResource[];
  groups: BrushLibraryGroup[];
}

export interface BrushLibraryImportResult {
  importedPresetCount: number;
  skippedPresetCount: number;
  importedTipCount: number;
  skippedTipCount: number;
  snapshot: BrushLibrarySnapshot;
}

interface BrushLibraryPresetPayload {
  preset: BrushPreset;
  tipId: string | null;
  group: string | null;
}

function findPresetById<T extends { id: string }>(items: T[], id: string | null): T | undefined {
  if (!id) {
    return undefined;
  }
  return items.find((item) => item.id === id);
}

function resolveSelectionTool(tool: string): BrushPresetSelectionTool {
  return tool === 'eraser' ? 'eraser' : 'brush';
}

function getSelectionToolFromToolStore(): BrushPresetSelectionTool {
  return resolveSelectionTool(useToolStore.getState().currentTool);
}

function getSelectedPresetIdForTool(
  selectedPresetByTool: BrushPresetSelectionByTool,
  tool: BrushPresetSelectionTool
): string | null {
  return selectedPresetByTool[tool] ?? null;
}

function setSelectedPresetIdForTool(
  selectedPresetByTool: BrushPresetSelectionByTool,
  tool: BrushPresetSelectionTool,
  id: string | null
): BrushPresetSelectionByTool {
  return {
    ...selectedPresetByTool,
    [tool]: id,
  };
}

function sanitizeSelectionByTool(
  presets: BrushLibraryPreset[],
  selectedPresetByTool: BrushPresetSelectionByTool
): BrushPresetSelectionByTool {
  const hasPreset = (id: string | null): boolean => !!findPresetById(presets, id);
  return {
    brush: hasPreset(selectedPresetByTool.brush) ? selectedPresetByTool.brush : null,
    eraser: hasPreset(selectedPresetByTool.eraser) ? selectedPresetByTool.eraser : null,
  };
}

interface BrushLibraryState {
  presets: BrushLibraryPreset[];
  tips: BrushTipResource[];
  groups: BrushLibraryGroup[];
  selectedPresetByTool: BrushPresetSelectionByTool;
  searchQuery: string;
  hasLoaded: boolean;
  isLoading: boolean;
  error: string | null;

  loadLibrary: () => Promise<void>;
  importAbrFile: (path: string) => Promise<BrushLibraryImportResult>;
  renamePreset: (id: string, newName: string) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
  deleteGroup: (groupName: string) => Promise<void>;
  movePresetToGroup: (id: string, group: string) => Promise<void>;
  renameGroup: (oldName: string, newName: string) => Promise<void>;
  saveActivePreset: () => Promise<BrushLibraryPreset | null>;
  saveActivePresetAs: (
    newName: string,
    targetGroup?: string | null
  ) => Promise<BrushLibraryPreset | null>;
  applyPresetById: (id: string) => void;
  applyMainTip: (tipId: string | null) => void;
  setSelectedPresetId: (id: string | null) => void;
  hydrateSelectionFromSettings: () => void;
  setSearchQuery: (query: string) => void;
  clearError: () => void;
}

const BRUSH_TEXTURE_PREWARM_LIMIT = 24;

function normalizePreset(preset: BrushLibraryPreset): BrushLibraryPreset {
  return {
    ...preset,
    tipId: preset.tipId ?? (preset.hasTexture ? preset.id : null),
    group: preset.group ?? null,
  };
}

function normalizeSnapshot(snapshot: BrushLibrarySnapshot): BrushLibrarySnapshot {
  return {
    presets: snapshot.presets.map(normalizePreset),
    tips: snapshot.tips,
    groups: snapshot.groups,
  };
}

function snapshotState(snapshot: BrushLibrarySnapshot) {
  return {
    presets: snapshot.presets,
    tips: snapshot.tips,
    groups: snapshot.groups,
  };
}

function buildTexturePrewarmCandidates(snapshot: BrushLibrarySnapshot): Array<{
  id: string;
  width: number;
  height: number;
}> {
  const candidates: Array<{ id: string; width: number; height: number }> = [];

  for (const preset of snapshot.presets) {
    if (!preset.hasTexture) {
      continue;
    }
    const textureId = preset.tipId ?? preset.id;
    const width = preset.textureWidth ?? 0;
    const height = preset.textureHeight ?? 0;
    candidates.push({ id: textureId, width, height });
  }

  for (const tip of snapshot.tips) {
    if (!tip.hasTexture) {
      continue;
    }
    const width = tip.textureWidth ?? 0;
    const height = tip.textureHeight ?? 0;
    candidates.push({ id: tip.id, width, height });
  }

  return candidates;
}

function normalizePresetId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readSelectionFromSettings(): BrushPresetSelectionByTool {
  const selection = useSettingsStore.getState().brushLibrary.selectedPresetByTool;
  return {
    brush: normalizePresetId(selection?.brush),
    eraser: normalizePresetId(selection?.eraser),
  };
}

function isSameSelection(
  left: BrushPresetSelectionByTool,
  right: BrushPresetSelectionByTool
): boolean {
  return left.brush === right.brush && left.eraser === right.eraser;
}

function persistSelectionToSettings(selection: BrushPresetSelectionByTool): void {
  const current = useSettingsStore.getState().brushLibrary.selectedPresetByTool;
  if (isSameSelection(selection, current)) {
    return;
  }
  useSettingsStore.getState().setBrushLibrarySelection(selection);
}

function buildDualBrushSettings(): DualBrushSettingsPreset | null {
  const state = useToolStore.getState();
  if (!state.dualBrushEnabled) {
    return null;
  }

  return {
    enabled: true,
    brushId: state.dualBrush.brushId,
    brushName: state.dualBrush.brushName,
    mode: state.dualBrush.mode,
    flip: state.dualBrush.flip,
    size: state.dualBrush.size,
    roundness: state.dualBrush.roundness ?? 100,
    sizeRatio: state.dualBrush.sizeRatio,
    spacing: state.dualBrush.spacing,
    scatter: state.dualBrush.scatter,
    bothAxes: state.dualBrush.bothAxes,
    count: state.dualBrush.count,
  };
}

function buildPresetFromToolState(
  currentPreset: BrushLibraryPreset | undefined,
  tips: BrushTipResource[]
): BrushLibraryPresetPayload {
  const tool = useToolStore.getState();
  const activeTipId = tool.brushTexture?.id ?? null;
  const activeTip = activeTipId ? tips.find((tip) => tip.id === activeTipId) : undefined;

  const name = currentPreset?.name ?? 'Custom Brush';
  const diameter = Math.round(tool.brushSize);
  const spacing = Math.round(tool.brushSpacing * 100);
  const hardness = Math.round(tool.brushHardness);
  const angle = Math.round(tool.brushAngle);
  const roundness = Math.round(tool.brushRoundness);

  const hasTexture = !!activeTipId;
  const textureWidth = activeTip?.textureWidth ?? tool.brushTexture?.width ?? null;
  const textureHeight = activeTip?.textureHeight ?? tool.brushTexture?.height ?? null;

  const preset: BrushPreset = {
    id: currentPreset?.id ?? `temp-${Date.now()}`,
    tipId: activeTipId,
    sourceUuid: currentPreset?.sourceUuid ?? activeTip?.sourceUuid ?? null,
    name,
    diameter,
    spacing,
    hardness,
    angle,
    roundness,
    hasTexture,
    isComputed: activeTip?.isComputed ?? currentPreset?.isComputed,
    textureWidth,
    textureHeight,
    sizePressure: tool.pressureSizeEnabled,
    opacityPressure: tool.pressureOpacityEnabled,
    cursorPath:
      activeTip?.cursorPath ?? currentPreset?.cursorPath ?? tool.brushTexture?.cursorPath ?? null,
    cursorBounds:
      activeTip?.cursorBounds ??
      currentPreset?.cursorBounds ??
      tool.brushTexture?.cursorBounds ??
      null,
    textureSettings: tool.textureSettings,
    dualBrushSettings: buildDualBrushSettings(),
    shapeDynamicsEnabled: tool.shapeDynamicsEnabled,
    shapeDynamics: tool.shapeDynamics,
    scatterEnabled: tool.scatterEnabled,
    scatter: tool.scatter,
    colorDynamicsEnabled: tool.colorDynamicsEnabled,
    colorDynamics: tool.colorDynamics,
    transferEnabled: tool.transferEnabled,
    transfer: tool.transfer,
    wetEdgeEnabled: tool.wetEdgeEnabled,
    buildupEnabled: tool.buildupEnabled,
    noiseEnabled: tool.noiseEnabled,
    baseOpacity: tool.brushOpacity,
    baseFlow: tool.brushFlow,
  };

  return {
    preset,
    tipId: activeTipId,
    group: currentPreset?.group ?? null,
  };
}

async function fetchLibrarySnapshot(): Promise<BrushLibrarySnapshot> {
  const snapshot = await invoke<BrushLibrarySnapshot>('get_brush_library');
  return normalizeSnapshot(snapshot);
}

export const useBrushLibraryStore = create<BrushLibraryState>((set, get) => {
  function commitSelection(selection: BrushPresetSelectionByTool): void {
    set({ selectedPresetByTool: selection });
    persistSelectionToSettings(selection);
  }

  function commitSnapshot(
    snapshot: BrushLibrarySnapshot,
    selection: BrushPresetSelectionByTool,
    isLoading?: boolean
  ): void {
    const sanitizedSelection = sanitizeSelectionByTool(snapshot.presets, selection);
    const nextState: Partial<BrushLibraryState> = {
      ...snapshotState(snapshot),
      selectedPresetByTool: sanitizedSelection,
      hasLoaded: true,
    };
    if (isLoading !== undefined) {
      nextState.isLoading = isLoading;
    }
    set(nextState);
    persistSelectionToSettings(sanitizedSelection);
    const prewarmCandidates = buildTexturePrewarmCandidates(snapshot);
    prewarmBrushTextures(prewarmCandidates, BRUSH_TEXTURE_PREWARM_LIMIT);
  }

  async function reloadSnapshot(selection: BrushPresetSelectionByTool): Promise<void> {
    const snapshot = await fetchLibrarySnapshot();
    commitSnapshot(snapshot, selection);
  }

  return {
    presets: [],
    tips: [],
    groups: [],
    selectedPresetByTool: readSelectionFromSettings(),
    searchQuery: '',
    hasLoaded: false,
    isLoading: false,
    error: null,

    loadLibrary: async () => {
      const { hasLoaded, isLoading } = get();
      if (hasLoaded || isLoading) {
        return;
      }

      set({ isLoading: true, error: null });
      try {
        const snapshot = await fetchLibrarySnapshot();
        commitSnapshot(snapshot, get().selectedPresetByTool, false);
      } catch (err) {
        set({ isLoading: false, error: String(err) });
      }
    },

    importAbrFile: async (path: string) => {
      set({ isLoading: true, error: null });
      try {
        const result = await invoke<BrushLibraryImportResult>('import_abr_to_brush_library', {
          path,
        });
        const normalized = {
          ...result,
          snapshot: normalizeSnapshot(result.snapshot),
        };
        commitSnapshot(normalized.snapshot, get().selectedPresetByTool, false);
        return normalized;
      } catch (err) {
        set({ isLoading: false, error: String(err) });
        throw err;
      }
    },

    renamePreset: async (id: string, newName: string) => {
      try {
        await invoke('rename_brush_preset', { id, newName });
        await reloadSnapshot(get().selectedPresetByTool);
      } catch (err) {
        set({ error: String(err) });
        throw err;
      }
    },

    deletePreset: async (id: string) => {
      try {
        await invoke('delete_brush_preset', { id });
        const selection = get().selectedPresetByTool;
        const nextSelection = {
          brush: selection.brush === id ? null : selection.brush,
          eraser: selection.eraser === id ? null : selection.eraser,
        };
        await reloadSnapshot(nextSelection);
      } catch (err) {
        set({ error: String(err) });
        throw err;
      }
    },

    deleteGroup: async (groupName: string) => {
      try {
        await invoke('delete_brush_group', { groupName });
        await reloadSnapshot(get().selectedPresetByTool);
      } catch (err) {
        set({ error: String(err) });
        throw err;
      }
    },

    movePresetToGroup: async (id: string, group: string) => {
      try {
        await invoke('move_brush_preset_to_group', { id, group });
        await reloadSnapshot(get().selectedPresetByTool);
      } catch (err) {
        set({ error: String(err) });
        throw err;
      }
    },

    renameGroup: async (oldName: string, newName: string) => {
      try {
        await invoke('rename_brush_group', { oldName, newName });
        await reloadSnapshot(get().selectedPresetByTool);
      } catch (err) {
        set({ error: String(err) });
        throw err;
      }
    },

    saveActivePreset: async () => {
      const tool = getSelectionToolFromToolStore();
      const { selectedPresetByTool, presets, tips } = get();
      const selectedPresetId = getSelectedPresetIdForTool(selectedPresetByTool, tool);
      const currentPreset = findPresetById(presets, selectedPresetId);

      if (!currentPreset) {
        return null;
      }

      const payload = buildPresetFromToolState(currentPreset, tips);
      const updated = normalizePreset(
        await invoke<BrushLibraryPreset>('save_brush_preset', { payload })
      );
      const snapshot = await fetchLibrarySnapshot();
      const nextSelection = setSelectedPresetIdForTool(selectedPresetByTool, tool, updated.id);
      commitSnapshot(snapshot, nextSelection);
      return updated;
    },

    saveActivePresetAs: async (newName: string, targetGroup?: string | null) => {
      const tool = getSelectionToolFromToolStore();
      const { selectedPresetByTool, presets, tips } = get();
      const selectedPresetId = getSelectedPresetIdForTool(selectedPresetByTool, tool);
      const currentPreset = findPresetById(presets, selectedPresetId);

      const payload = buildPresetFromToolState(currentPreset, tips);
      const created = normalizePreset(
        await invoke<BrushLibraryPreset>('save_brush_preset_as', {
          payload,
          newName,
          targetGroup: targetGroup ?? null,
        })
      );

      const snapshot = await fetchLibrarySnapshot();
      const nextSelection = setSelectedPresetIdForTool(selectedPresetByTool, tool, created.id);
      commitSnapshot(snapshot, nextSelection);

      get().applyPresetById(created.id);
      return created;
    },

    applyPresetById: (id: string) => {
      const tool = getSelectionToolFromToolStore();
      const { presets, tips } = get();
      const preset = findPresetById(presets, id);
      if (!preset) {
        return;
      }

      applyPresetToToolStore(preset, tips);
      const nextSelection = setSelectedPresetIdForTool(get().selectedPresetByTool, tool, id);
      commitSelection(nextSelection);
    },

    applyMainTip: (tipId: string | null) => {
      const tip = findPresetById(get().tips, tipId);
      const tool = useToolStore.getState();

      if (!tip) {
        tool.clearBrushTexture();
        return;
      }

      tool.setBrushSize(Math.max(1, Math.round(tip.diameter)));
      tool.setBrushHardness(Math.max(0, Math.round(tip.hardness)));
      tool.setBrushRoundness(Math.max(1, Math.round(tip.roundness)));
      tool.setBrushAngle(Math.round(tip.angle));
      tool.setBrushSpacing(Math.max(0.01, tip.spacing / 100));

      if (tip.hasTexture && tip.textureWidth && tip.textureHeight) {
        tool.setBrushTexture({
          id: tip.id,
          data: '',
          width: tip.textureWidth,
          height: tip.textureHeight,
          cursorPath: tip.cursorPath ?? undefined,
          cursorBounds: tip.cursorBounds ?? undefined,
        });
        return;
      }

      tool.clearBrushTexture();
    },

    setSelectedPresetId: (id: string | null) => {
      const tool = getSelectionToolFromToolStore();
      const nextSelection = setSelectedPresetIdForTool(get().selectedPresetByTool, tool, id);
      commitSelection(nextSelection);
    },

    hydrateSelectionFromSettings: () => {
      const fromSettings = readSelectionFromSettings();
      if (isSameSelection(get().selectedPresetByTool, fromSettings)) {
        return;
      }
      set({ selectedPresetByTool: fromSettings });
    },

    setSearchQuery: (query: string) => set({ searchQuery: query }),

    clearError: () => set({ error: null }),
  };
});

export function useSelectedPresetIdForCurrentTool(): string | null {
  const selectionTool = useToolStore((state) => resolveSelectionTool(state.currentTool));
  return useBrushLibraryStore((state) => state.selectedPresetByTool[selectionTool]);
}

export function useFilteredBrushPresets(): BrushLibraryPreset[] {
  const presets = useBrushLibraryStore((state) => state.presets);
  const searchQuery = useBrushLibraryStore((state) => state.searchQuery);

  const query = searchQuery.trim().toLowerCase();
  if (!query) {
    return presets;
  }

  return presets.filter((preset) => {
    const nameMatch = preset.name.toLowerCase().includes(query);
    const groupMatch = (preset.group ?? '').toLowerCase().includes(query);
    return nameMatch || groupMatch;
  });
}

export interface GroupedBrushPresets {
  name: string;
  presets: BrushLibraryPreset[];
}

export function useGroupedBrushPresets(): GroupedBrushPresets[] {
  const groups = useBrushLibraryStore((state) => state.groups);
  const filtered = useFilteredBrushPresets();

  const presetMap = new Map(filtered.map((preset) => [preset.id, preset]));
  const grouped: GroupedBrushPresets[] = [];
  const groupedIds = new Set<string>();

  for (const group of groups) {
    const presets = group.presetIds
      .map((id) => presetMap.get(id))
      .filter((preset): preset is BrushLibraryPreset => !!preset);

    if (presets.length > 0) {
      grouped.push({ name: group.name, presets });
      presets.forEach((preset) => groupedIds.add(preset.id));
    }
  }

  const ungrouped = filtered.filter((preset) => !groupedIds.has(preset.id));
  if (ungrouped.length > 0) {
    grouped.push({ name: 'Ungrouped', presets: ungrouped });
  }

  return grouped;
}

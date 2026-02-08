import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useToolStore, BrushTexture } from '@/stores/tool';
import {
  BrushPreset,
  DEFAULT_ROUND_BRUSH,
  DEFAULT_TEXTURE_SETTINGS,
  ImportAbrResult,
} from '../types';
import { BrushPresetThumbnail } from '../BrushPresetThumbnail';
import { loadBrushTexture } from '@/utils/brushLoader';

interface BrushPresetsProps {
  importedPresets: BrushPreset[];
  setImportedPresets: (presets: BrushPreset[]) => void;
  importedTips: BrushPreset[];
  setImportedTips: (tips: BrushPreset[]) => void;
}

function createBrushTextureFromPreset(preset: BrushPreset): BrushTexture | undefined {
  if (!preset.hasTexture || !preset.textureWidth || !preset.textureHeight) {
    return undefined;
  }
  const textureId = preset.tipId ?? preset.id;

  return {
    id: textureId,
    data: '',
    width: preset.textureWidth,
    height: preset.textureHeight,
  };
}

function preloadDualTextureIfNeeded(texture: BrushTexture | undefined): void {
  if (!texture) return;

  loadBrushTexture(texture.id, texture.width, texture.height)
    .then((imageData) => {
      if (!imageData) return;

      const currentBrushId = useToolStore.getState().dualBrush.brushId;
      if (currentBrushId !== texture.id) return;

      useToolStore.setState((state) => {
        const currentDual = state.dualBrush;
        if (currentDual.brushId !== texture.id || !currentDual.texture) return state;

        return {
          dualBrush: {
            ...currentDual,
            texture: {
              ...currentDual.texture,
              imageData,
            },
          },
        };
      });
    })
    .catch((err) => {
      console.error('[DualBrush] Failed to preload texture (preset apply):', err);
    });
}

export function applyPresetToToolStore(preset: BrushPreset, importedTips: BrushPreset[]): void {
  const {
    setBrushSize,
    setBrushHardness,
    setBrushSpacing,
    setBrushRoundness,
    setBrushAngle,
    setBrushOpacity,
    setBrushFlow,
    setBrushTexture,
    clearBrushTexture,
    setTextureEnabled,
    setTextureSettings,
    resetShapeDynamics,
    setShapeDynamicsEnabled,
    setShapeDynamics,
    resetScatter,
    setScatterEnabled,
    setScatter,
    resetColorDynamics,
    setColorDynamicsEnabled,
    setColorDynamics,
    resetTransfer,
    setTransferEnabled,
    setTransfer,
    setWetEdgeEnabled,
    setBuildupEnabled,
    setNoiseEnabled,
    resetDualBrush,
    setDualBrushEnabled,
    setDualBrush,
  } = useToolStore.getState();

  // Reset Dual Brush first to prevent preset-to-preset leakage
  resetDualBrush();
  setDualBrushEnabled(false);

  setBrushSize(Math.round(preset.diameter));
  setBrushHardness(Math.round(preset.hardness));
  setBrushSpacing(preset.spacing / 100);
  setBrushRoundness(Math.round(preset.roundness));
  setBrushAngle(Math.round(preset.angle));

  // Base Opacity/Flow (reset to defaults when missing to avoid preset-to-preset leakage)
  setBrushOpacity(preset.baseOpacity ?? 1);
  setBrushFlow(preset.baseFlow ?? 1);

  // Reset Photoshop-compatible dynamics panels to avoid leaking state across presets
  resetShapeDynamics();
  setShapeDynamicsEnabled(false);
  resetScatter();
  setScatterEnabled(false);
  resetColorDynamics();
  setColorDynamicsEnabled(false);
  resetTransfer();
  setTransferEnabled(false);
  setWetEdgeEnabled(preset.wetEdgeEnabled === true);
  setBuildupEnabled(preset.buildupEnabled === true);
  setNoiseEnabled(preset.noiseEnabled === true);

  if (preset.shapeDynamicsEnabled === true) {
    if (preset.shapeDynamics) setShapeDynamics(preset.shapeDynamics);
    setShapeDynamicsEnabled(true);
  }
  if (preset.scatterEnabled === true) {
    if (preset.scatter) setScatter(preset.scatter);
    setScatterEnabled(true);
  }
  if (preset.colorDynamicsEnabled === true) {
    if (preset.colorDynamics) setColorDynamics(preset.colorDynamics);
    setColorDynamicsEnabled(true);
  }
  if (preset.transferEnabled === true) {
    if (preset.transfer) setTransfer(preset.transfer);
    setTransferEnabled(true);
  }

  // Apply texture reference if preset has one
  // Note: Texture data is fetched via protocol when needed for rendering
  if (preset.hasTexture && preset.textureWidth && preset.textureHeight) {
    const textureId = preset.tipId ?? preset.id;
    const texture: BrushTexture = {
      id: textureId,
      // Data will be fetched via project://brush/{id} when rendering
      data: '', // Empty - not used for rendering anymore
      width: preset.textureWidth,
      height: preset.textureHeight,
      cursorPath: preset.cursorPath ?? undefined,
      cursorBounds: preset.cursorBounds ?? undefined,
    };
    setBrushTexture(texture);
  } else {
    // Clear texture for procedural brushes
    clearBrushTexture();
  }

  // Apply texture settings from preset (Photoshop Texture panel)
  // Enable texture only if preset has textureSettings with a patternId
  // Note: hasTexture indicates sampled brush (tip image), NOT Texture Tab
  const shouldEnableTexture = !!preset.textureSettings?.patternId;

  if (preset.textureSettings) {
    // Use preset's texture settings if available
    setTextureSettings(preset.textureSettings);
  } else {
    // Reset to defaults if preset has no texture settings
    setTextureSettings(DEFAULT_TEXTURE_SETTINGS);
  }

  // Enable texture based on preset's texture settings, not brush tip type
  setTextureEnabled(shouldEnableTexture);

  // Apply dual brush settings from preset (Photoshop Dual Brush panel)
  if (preset.dualBrushSettings?.enabled === true) {
    const dual = preset.dualBrushSettings;

    let secondaryPreset: BrushPreset | null = null;
    let brushIndex: number | null = null;
    if (dual.brushId) {
      const idx = importedTips.findIndex(
        (p) => p.id === dual.brushId || p.sourceUuid === dual.brushId
      );
      if (idx >= 0) {
        secondaryPreset = importedTips[idx] ?? null;
        brushIndex = idx;
      }
    }

    const texture = secondaryPreset ? createBrushTextureFromPreset(secondaryPreset) : undefined;
    const resolvedBrushId = secondaryPreset?.id ?? dual.brushId ?? null;

    setDualBrushEnabled(true);
    setDualBrush({
      enabled: true,
      brushId: resolvedBrushId,
      brushIndex,
      brushName: dual.brushName ?? secondaryPreset?.name ?? null,
      mode: dual.mode,
      flip: dual.flip,
      spacing: dual.spacing,
      scatter: dual.scatter,
      bothAxes: dual.bothAxes,
      count: dual.count,
      roundness: dual.roundness,
      texture,
      sizeRatio: dual.sizeRatio,
    });

    // Preload secondary texture to avoid "first stroke black" issue
    preloadDualTextureIfNeeded(texture);
  }
}

export function BrushPresets({
  importedPresets,
  setImportedPresets,
  importedTips,
  setImportedTips,
}: BrushPresetsProps): JSX.Element {
  const [selectedPresetId, setSelectedPresetId] = useState<string>(DEFAULT_ROUND_BRUSH.id);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  /** Import ABR file (optimized: zero-encoding, LZ4 compression) */
  const handleImportABR = async () => {
    setIsImporting(true);
    setImportError(null);

    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Photoshop Brushes', extensions: ['abr'] }],
      });

      if (selected) {
        const result = await invoke<ImportAbrResult>('import_abr_file', {
          path: selected,
        });

        // Add presets (dedupe by ID to prevent React key conflicts)
        const existingIds = new Set(importedPresets.map((p) => p.id));
        const newPresets = result.presets.filter((p) => !existingIds.has(p.id));
        setImportedPresets([...importedPresets, ...newPresets]);

        // Add tips (for Dual Brush selector; includes tip-only brushes)
        const existingTipIds = new Set(importedTips.map((p) => p.id));
        const newTips = result.tips.filter((p) => !existingTipIds.has(p.id));
        setImportedTips([...importedTips, ...newTips]);

        // Add patterns if any
        if (result.patterns && result.patterns.length > 0) {
          useToolStore.getState().appendPatterns(result.patterns);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setImportError(message);
      console.error('[ABR Import] Failed:', err);
    } finally {
      setIsImporting(false);
    }
  };

  /** Apply preset to current brush settings */
  const applyPreset = (preset: BrushPreset) => {
    // Update selected preset ID for visual feedback
    setSelectedPresetId(preset.id);

    applyPresetToToolStore(preset, importedTips);
  };

  return (
    <div className="brush-panel-section">
      <h4>Brush Presets</h4>
      <button className="abr-import-btn" onClick={handleImportABR} disabled={isImporting}>
        {isImporting ? 'Importing...' : 'Import ABR'}
      </button>

      {importError && <div className="abr-error">{importError}</div>}

      <div className="abr-preset-grid">
        {/* Default round brush - always first */}
        <button
          className={`abr-preset-item ${selectedPresetId === DEFAULT_ROUND_BRUSH.id ? 'selected' : ''}`}
          onClick={() => applyPreset(DEFAULT_ROUND_BRUSH)}
          title="Round Brush (Default)\nProcedural brush with soft edges"
        >
          <div className="abr-preset-round-icon" />
        </button>

        {/* Imported presets - using BrushThumbnail for texture display */}
        {importedPresets.map((preset, index) => {
          return (
            <button
              key={`${preset.id}-${index}`}
              className={`abr-preset-item ${selectedPresetId === preset.id ? 'selected' : ''}`}
              onClick={() => applyPreset(preset)}
              title={`${preset.name}\n${preset.diameter}px, ${preset.hardness}% hardness`}
            >
              <BrushPresetThumbnail preset={preset} size={48} className="abr-preset-texture" />
              <span className="abr-preset-name">{preset.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

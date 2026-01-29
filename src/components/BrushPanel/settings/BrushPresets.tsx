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
import { BrushThumbnail } from '../BrushThumbnail';

interface BrushPresetsProps {
  importedPresets: BrushPreset[];
  setImportedPresets: (presets: BrushPreset[]) => void;
}

export function BrushPresets({
  importedPresets,
  setImportedPresets,
}: BrushPresetsProps): JSX.Element {
  const [selectedPresetId, setSelectedPresetId] = useState<string>(DEFAULT_ROUND_BRUSH.id);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const {
    setBrushSize,
    setBrushHardness,
    setBrushSpacing,
    setBrushRoundness,
    setBrushAngle,
    setBrushTexture,
    clearBrushTexture,
    setTextureEnabled,
    setTextureSettings,
  } = useToolStore();

  /** Import ABR file (optimized: zero-encoding, LZ4 compression) */
  const handleImportABR = async () => {
    setIsImporting(true);
    setImportError(null);

    const frontendStart = performance.now();

    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Photoshop Brushes', extensions: ['abr'] }],
      });

      if (selected) {
        const result = await invoke<ImportAbrResult>('import_abr_file', {
          path: selected,
        });

        const frontendTime = performance.now() - frontendStart;

        // Frontend benchmark log
        console.log(
          `[ABR Import] Frontend received ${result.presets.length} brushes, ${result.benchmark.patternCount} patterns in ${frontendTime.toFixed(2)}ms`
        );
        console.log(`[ABR Import] Backend benchmark:`, result.benchmark);

        setImportedPresets(result.presets);
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

    setBrushSize(Math.round(preset.diameter));
    setBrushHardness(Math.round(preset.hardness));
    setBrushSpacing(preset.spacing / 100);
    setBrushRoundness(Math.round(preset.roundness));
    setBrushAngle(Math.round(preset.angle));

    // Apply texture reference if preset has one
    // Note: Texture data is fetched via protocol when needed for rendering
    if (preset.hasTexture && preset.textureWidth && preset.textureHeight) {
      const texture: BrushTexture = {
        id: preset.id,
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
    // Enable texture if preset has texture data (hasTexture indicates sampled brush)
    const shouldEnableTexture = preset.hasTexture;

    if (preset.textureSettings) {
      // Use preset's texture settings if available
      setTextureSettings(preset.textureSettings);
    } else {
      // Reset to defaults if preset has no texture settings
      setTextureSettings(DEFAULT_TEXTURE_SETTINGS);
    }

    // Enable texture based on whether the brush has texture data
    setTextureEnabled(shouldEnableTexture);
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
        {importedPresets.map((preset) => (
          <button
            key={preset.id}
            className={`abr-preset-item ${selectedPresetId === preset.id ? 'selected' : ''}`}
            onClick={() => applyPreset(preset)}
            title={`${preset.name}\n${preset.diameter}px, ${preset.hardness}% hardness`}
          >
            {preset.hasTexture ? (
              <BrushThumbnail
                brushId={preset.id}
                size={48}
                alt={preset.name}
                className="abr-preset-texture"
              />
            ) : (
              <div className="abr-preset-placeholder">{Math.round(preset.diameter)}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

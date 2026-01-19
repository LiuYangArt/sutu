import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useToolStore, BrushTexture } from '@/stores/tool';
import { BrushPreset, DEFAULT_ROUND_BRUSH } from '../types';

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
  } = useToolStore();

  /** Import ABR file */
  const handleImportABR = async () => {
    setIsImporting(true);
    setImportError(null);

    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Photoshop Brushes', extensions: ['abr'] }],
      });

      if (selected) {
        const presets = await invoke<BrushPreset[]>('import_abr_file', {
          path: selected,
        });
        setImportedPresets(presets);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setImportError(message);
      console.error('ABR import failed:', err);
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

    // Apply texture if preset has one
    if (preset.hasTexture && preset.textureData && preset.textureWidth && preset.textureHeight) {
      const texture: BrushTexture = {
        data: preset.textureData,
        width: preset.textureWidth,
        height: preset.textureHeight,
      };
      setBrushTexture(texture);
    } else {
      // Clear texture for procedural brushes
      clearBrushTexture();
    }
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

        {/* Imported presets */}
        {importedPresets.map((preset) => (
          <button
            key={preset.id}
            className={`abr-preset-item ${selectedPresetId === preset.id ? 'selected' : ''}`}
            onClick={() => applyPreset(preset)}
            title={`${preset.name}\n${preset.diameter}px, ${preset.hardness}% hardness`}
          >
            {preset.hasTexture && preset.textureData ? (
              <img
                src={`data:image/png;base64,${preset.textureData}`}
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

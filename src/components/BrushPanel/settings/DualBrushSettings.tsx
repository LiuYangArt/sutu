/**
 * DualBrushSettings - Photoshop-compatible Dual Brush panel
 *
 * Controls the secondary brush that acts as a texture mask for the primary brush:
 * - Mode: Blend mode for combining with primary brush
 * - Brush Selector: Choose the secondary brush tip
 * - Size/Spacing: Override secondary brush dimensions
 * - Scatter/Count: Control distribution of secondary dabs
 */

import { useToolStore, DualBlendMode } from '@/stores/tool';
import { useBrushLibraryStore } from '@/stores/brushLibrary';
import { SliderRow, SelectRow, SelectOption } from '../BrushPanelComponents';
import { BrushPresetThumbnail } from '../BrushPresetThumbnail';
import { loadBrushTexture } from '@/utils/brushLoader';
import { BRUSH_SIZE_SLIDER_CONFIG } from '@/utils/sliderScales';

// PS Dual Brush only supports these 8 blend modes
const BLEND_MODE_OPTIONS: SelectOption[] = [
  { value: 'multiply', label: 'Multiply' },
  { value: 'darken', label: 'Darken' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'colorDodge', label: 'Color Dodge' },
  { value: 'colorBurn', label: 'Color Burn' },
  { value: 'linearBurn', label: 'Linear Burn' },
  { value: 'hardMix', label: 'Hard Mix' },
  { value: 'linearHeight', label: 'Linear Height' },
];

export function DualBrushSettings(): JSX.Element {
  const { dualBrush, setDualBrush, dualBrushEnabled } = useToolStore();
  const importedTips = useBrushLibraryStore((state) => state.tips);

  const disabled = !dualBrushEnabled;
  const ratioPercent = Math.round(dualBrush.sizeRatio * 100);

  const handlePresetSelect = (tipId: string, index: number) => {
    const preset = importedTips[index];
    if (!preset) return;

    // 1. Immediate UI update
    setDualBrush({
      brushId: tipId,
      brushIndex: index,
      brushName: preset.name,
      roundness: preset.roundness,
      texture: preset.hasTexture
        ? {
            id: preset.id,
            data: '', // Loaded via project://brush/{id} protocol
            width: preset.textureWidth ?? 0,
            height: preset.textureHeight ?? 0,
          }
        : undefined,
    });

    // 2. Preload texture to prevent "first stroke black" issue
    if (preset.hasTexture) {
      loadBrushTexture(tipId, preset.textureWidth ?? 0, preset.textureHeight ?? 0)
        .then((imageData) => {
          if (!imageData) return;

          // Double-check if selection changed during load
          const currentBrushId = useToolStore.getState().dualBrush.brushId;
          if (currentBrushId === tipId) {
            useToolStore.setState((state) => {
              const dual = state.dualBrush;
              if (dual.brushId !== tipId || !dual.texture) return state;

              return {
                dualBrush: {
                  ...dual,
                  texture: {
                    ...dual.texture,
                    imageData,
                  },
                },
              };
            });
          }
        })
        .catch((err) => {
          console.error('[DualBrush] Failed to preload texture:', err);
        });
    }
  };

  return (
    <div className="brush-panel-section">
      {/* Section header */}
      <div className="section-header-row">
        <h4>Dual Brush</h4>
      </div>

      {/* Mode & Flip */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SelectRow
          label="Mode"
          value={dualBrush.mode}
          options={BLEND_MODE_OPTIONS}
          onChange={(v) => setDualBrush({ mode: v as DualBlendMode })}
          disabled={disabled}
        />
        <label className={`flip-checkbox ${disabled ? 'disabled' : ''}`}>
          <input
            type="checkbox"
            checked={dualBrush.flip}
            onChange={() => setDualBrush({ flip: !dualBrush.flip })}
            disabled={disabled}
          />
          <span>Flip</span>
        </label>
      </div>

      {/* Secondary Brush Selector - Mini Grid */}
      <div className={`dual-brush-selector-group ${disabled ? 'disabled' : ''}`}>
        <label className="brush-setting-label">Secondary Brush Tip</label>
        <div
          className="abr-preset-grid mini-grid"
          style={{
            maxHeight: '300px',
            overflowY: 'auto',
            marginTop: '8px',
            border: '1px solid #333',
            padding: '4px',
          }}
        >
          {/* Default round brush option */}
          <button
            className={`abr-preset-item ${dualBrush.brushId === null ? 'selected' : ''}`}
            onClick={() =>
              setDualBrush({ brushId: null, brushName: 'Default Round', roundness: 100 })
            }
            title="Default Round Brush"
            disabled={disabled}
          >
            <div className="abr-preset-round-icon" style={{ width: '24px', height: '24px' }} />
          </button>

          {/* Imported presets */}
          {importedTips.map((preset, index) => {
            return (
              <button
                key={`dual-${preset.id}-${index}`}
                className={`abr-preset-item ${dualBrush.brushId === preset.id ? 'selected' : ''}`}
                onClick={() => handlePresetSelect(preset.id, index)}
                title={preset.name}
                disabled={disabled}
              >
                <BrushPresetThumbnail
                  preset={preset}
                  size={32}
                  className="abr-preset-texture"
                  placeholderStyle={{ fontSize: '10px' }}
                />
              </button>
            );
          })}
        </div>
        {dualBrush.brushName && (
          <div
            className="selected-brush-name"
            style={{
              fontSize: '11px',
              marginTop: '4px',
              color: '#888',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {dualBrush.brushName}
          </div>
        )}
      </div>

      {/* Dimensions Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Size"
          value={dualBrush.size}
          min={1}
          max={1000}
          displayValue={`${Math.round(dualBrush.size)} px (${ratioPercent}%)`}
          onChange={(v) => setDualBrush({ size: v })}
          disabled={disabled}
          nonLinearConfig={BRUSH_SIZE_SLIDER_CONFIG}
        />
        <SliderRow
          label="Spacing"
          value={Math.round(dualBrush.spacing * 100)}
          min={1}
          max={1000}
          displayValue={`${Math.round(dualBrush.spacing * 100)}%`}
          onChange={(v) => setDualBrush({ spacing: v / 100 })}
          disabled={disabled}
          nonLinearConfig={BRUSH_SIZE_SLIDER_CONFIG}
        />
      </div>

      {/* Scatter Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Scatter"
          value={dualBrush.scatter}
          min={0}
          max={1000}
          displayValue={`${dualBrush.scatter}%`}
          onChange={(v) => setDualBrush({ scatter: v })}
          disabled={disabled}
        />
        <label className={`flip-checkbox ${disabled ? 'disabled' : ''}`}>
          <input
            type="checkbox"
            checked={dualBrush.bothAxes}
            onChange={() => setDualBrush({ bothAxes: !dualBrush.bothAxes })}
            disabled={disabled}
          />
          <span>Both Axes</span>
        </label>
      </div>

      {/* Count Group */}
      <div className={`dynamics-group ${disabled ? 'disabled' : ''}`}>
        <SliderRow
          label="Count"
          value={dualBrush.count}
          min={1}
          max={16}
          displayValue={`${dualBrush.count}`}
          onChange={(v) => setDualBrush({ count: v })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

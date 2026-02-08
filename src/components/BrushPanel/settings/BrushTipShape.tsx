import { useMemo } from 'react';
import { useToolStore, BrushMaskType } from '@/stores/tool';
import { useBrushLibraryStore } from '@/stores/brushLibrary';
import { SliderRow } from '../BrushPanelComponents';
import { BRUSH_SIZE_SLIDER_CONFIG } from '@/utils/sliderScales';
import { BrushPresetThumbnail } from '../BrushPresetThumbnail';

export function BrushTipShape(): JSX.Element {
  const {
    brushSize,
    setBrushSize,
    brushHardness,
    setBrushHardness,
    brushMaskType,
    setBrushMaskType,
    brushRoundness,
    setBrushRoundness,
    brushAngle,
    setBrushAngle,
    brushSpacing,
    setBrushSpacing,
    brushTexture,
    clearBrushTexture,
  } = useToolStore();

  const tips = useBrushLibraryStore((state) => state.tips);
  const selectedPresetId = useBrushLibraryStore((state) => state.selectedPresetId);
  const presets = useBrushLibraryStore((state) => state.presets);
  const applyMainTip = useBrushLibraryStore((state) => state.applyMainTip);
  const saveActivePreset = useBrushLibraryStore((state) => state.saveActivePreset);
  const saveActivePresetAs = useBrushLibraryStore((state) => state.saveActivePresetAs);
  const setSelectedPresetId = useBrushLibraryStore((state) => state.setSelectedPresetId);

  const activePreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? null,
    [presets, selectedPresetId]
  );

  const activeTipId = brushTexture?.id ?? null;

  const handleSave = async () => {
    try {
      const saved = await saveActivePreset();
      if (!saved) {
        const fallbackName = activePreset?.name ?? 'New Brush Preset';
        const newName = window.prompt('Preset name', fallbackName)?.trim();
        if (!newName) return;
        const group = window.prompt('Group name (optional)', activePreset?.group ?? '')?.trim();
        await saveActivePresetAs(newName, group || null);
        return;
      }

      setSelectedPresetId(saved.id);
    } catch (err) {
      console.error('[BrushTipShape] save failed', err);
      return;
    }
  };

  const handleSaveAs = async () => {
    try {
      const defaultName = activePreset?.name ? `${activePreset.name} Copy` : 'New Brush Preset';
      const newName = window.prompt('Preset name', defaultName)?.trim();
      if (!newName) {
        return;
      }

      const group = window.prompt('Group name (optional)', activePreset?.group ?? '')?.trim();
      await saveActivePresetAs(newName, group || null);
    } catch (err) {
      console.error('[BrushTipShape] save as failed', err);
      return;
    }
  };

  return (
    <div className="brush-panel-section">
      <h4>Brush Tip Shape</h4>

      <div className="dual-brush-selector-group" style={{ marginTop: '8px' }}>
        <label className="brush-setting-label">Main Tip</label>
        <div
          className="abr-preset-grid mini-grid"
          style={{
            maxHeight: '220px',
            overflowY: 'auto',
            marginTop: '8px',
            border: '1px solid #333',
            padding: '4px',
          }}
        >
          <button
            className={`abr-preset-item ${activeTipId === null ? 'selected' : ''}`}
            onClick={() => clearBrushTexture()}
            title="Default Round"
          >
            <div className="abr-preset-round-icon" style={{ width: '24px', height: '24px' }} />
          </button>

          {tips.map((tip) => (
            <button
              key={`main-tip-${tip.id}`}
              className={`abr-preset-item ${activeTipId === tip.id ? 'selected' : ''}`}
              onClick={() => applyMainTip(tip.id)}
              title={tip.name}
            >
              <BrushPresetThumbnail
                preset={tip}
                size={32}
                className="abr-preset-texture"
                placeholderStyle={{ fontSize: '10px' }}
              />
            </button>
          ))}
        </div>
      </div>

      <div className="brush-setting-row" style={{ gap: '6px', marginTop: '8px' }}>
        <button className="abr-import-btn" style={{ flex: 1 }} onClick={() => void handleSave()}>
          Save
        </button>
        <button className="abr-import-btn" style={{ flex: 1 }} onClick={() => void handleSaveAs()}>
          Save As
        </button>
      </div>

      <SliderRow
        label="Size"
        value={brushSize}
        min={1}
        max={1000}
        displayValue={`${brushSize}px`}
        onChange={setBrushSize}
        nonLinearConfig={BRUSH_SIZE_SLIDER_CONFIG}
      />

      <SliderRow
        label="Hardness"
        value={brushHardness}
        min={0}
        max={100}
        displayValue={`${brushHardness}%`}
        onChange={setBrushHardness}
      />

      <div className="brush-setting-row">
        <span className="brush-setting-label">Softness</span>
        <select
          value={brushMaskType}
          onChange={(e) => setBrushMaskType(e.target.value as BrushMaskType)}
          className="brush-select"
        >
          <option value="gaussian">Gaussian (Smooth)</option>
          <option value="default">Default</option>
        </select>
      </div>

      <SliderRow
        label="Roundness"
        value={brushRoundness}
        min={1}
        max={100}
        displayValue={`${brushRoundness}%`}
        onChange={setBrushRoundness}
      />

      <SliderRow
        label="Angle"
        value={brushAngle}
        min={0}
        max={360}
        displayValue={`${brushAngle}deg`}
        onChange={setBrushAngle}
      />

      <SliderRow
        label="Spacing"
        value={Math.round(brushSpacing * 100)}
        min={1}
        max={1000}
        displayValue={`${Math.round(brushSpacing * 100)}%`}
        onChange={(v) => setBrushSpacing(v / 100)}
        nonLinearConfig={BRUSH_SIZE_SLIDER_CONFIG}
      />
    </div>
  );
}

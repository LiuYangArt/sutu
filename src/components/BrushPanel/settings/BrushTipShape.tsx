import { useMemo } from 'react';
import { useToolStore, BrushMaskType } from '@/stores/tool';
import { useBrushLibraryStore, type BrushTipResource } from '@/stores/brushLibrary';
import { SliderRow } from '../BrushPanelComponents';
import { BRUSH_SIZE_SLIDER_CONFIG } from '@/utils/sliderScales';
import { BrushPresetThumbnail } from '../BrushPresetThumbnail';
import { VirtualizedTipGrid } from '../VirtualizedTipGrid';

type MainTipListItem =
  | { kind: 'default' }
  | { kind: 'tip'; id: string; name: string; preset: BrushTipResource };

function buildMainTipItems(tips: BrushTipResource[]): MainTipListItem[] {
  const importedTips: MainTipListItem[] = tips.map((tip) => ({
    kind: 'tip',
    id: tip.id,
    name: tip.name,
    preset: tip,
  }));

  return [{ kind: 'default' }, ...importedTips];
}

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
  const applyMainTip = useBrushLibraryStore((state) => state.applyMainTip);

  const activeTipId = brushTexture?.id ?? null;
  const tipItems = useMemo<MainTipListItem[]>(() => buildMainTipItems(tips), [tips]);

  function renderTipItem(item: MainTipListItem): JSX.Element {
    if (item.kind === 'default') {
      return (
        <button
          className={`abr-preset-item ${activeTipId === null ? 'selected' : ''}`}
          onClick={() => clearBrushTexture()}
          title="Default Round"
        >
          <div className="abr-preset-round-icon" style={{ width: '24px', height: '24px' }} />
        </button>
      );
    }

    return (
      <button
        className={`abr-preset-item ${activeTipId === item.id ? 'selected' : ''}`}
        onClick={() => applyMainTip(item.id)}
        title={item.name}
      >
        <BrushPresetThumbnail
          preset={item.preset}
          size={32}
          className="abr-preset-texture"
          placeholderStyle={{ fontSize: '10px' }}
        />
      </button>
    );
  }

  return (
    <div className="brush-panel-section">
      <h4>Brush Tip Shape</h4>

      <div className="dual-brush-selector-group" style={{ marginTop: '8px' }}>
        <label className="brush-setting-label">Main Tip</label>
        <VirtualizedTipGrid
          items={tipItems}
          getItemKey={(item) =>
            item.kind === 'default' ? 'main-tip-default' : `main-tip-${item.id}`
          }
          maxHeight={220}
          className="abr-preset-grid mini-grid"
          renderItem={(item) => renderTipItem(item)}
        />
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

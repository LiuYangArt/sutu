import { Crosshair, SlidersHorizontal } from 'lucide-react';
import { useNonLinearSlider } from '@/hooks/useNonLinearSlider';
import { useToolStore } from '@/stores/tool';
import { usePanelStore } from '@/stores/panel';
import { BRUSH_SIZE_SLIDER_CONFIG } from '@/utils/sliderScales';

const ICON_PROPS = { size: 18, strokeWidth: 1.5 } as const;

/** Pressure toggle button component */
function PressureToggle({
  enabled,
  onToggle,
  title,
}: {
  enabled: boolean;
  onToggle: () => void;
  title: string;
}) {
  return (
    <button
      className={`pressure-toggle ${enabled ? 'active' : ''}`}
      onClick={onToggle}
      title={title}
    >
      P
    </button>
  );
}

export function BrushToolbar() {
  const {
    currentTool,
    brushSize,
    eraserSize,
    setCurrentSize,
    brushFlow,
    setBrushFlow,
    brushOpacity,
    setBrushOpacity,
    pressureSizeEnabled,
    togglePressureSize,
    pressureFlowEnabled,
    togglePressureFlow,
    pressureOpacityEnabled,
    togglePressureOpacity,
    showCrosshair,
    toggleCrosshair,
  } = useToolStore();

  // Brush panel toggle
  const brushPanelOpen = usePanelStore((s) => s.panels['brush-panel']?.isOpen);
  const openPanel = usePanelStore((s) => s.openPanel);
  const closePanel = usePanelStore((s) => s.closePanel);

  const toggleBrushPanel = () => {
    if (brushPanelOpen) {
      closePanel('brush-panel');
    } else {
      openPanel('brush-panel');
    }
  };

  // Get current tool size (brush or eraser)
  const currentSize = currentTool === 'eraser' ? eraserSize : brushSize;

  const {
    sliderPosition: sizeSliderPosition,
    internalMax: sizeSliderMax,
    calculateValue: calculateSizeValue,
  } = useNonLinearSlider({
    value: currentSize,
    min: 1,
    max: 1000,
    nonLinearConfig: BRUSH_SIZE_SLIDER_CONFIG,
  });

  return (
    <div className="toolbar-section brush-settings">
      <label className="setting">
        <span className="setting-label">Size</span>
        <PressureToggle
          enabled={pressureSizeEnabled}
          onToggle={togglePressureSize}
          title="Pressure affects size"
        />
        <input
          type="range"
          min={0}
          max={sizeSliderMax}
          step={1}
          value={sizeSliderPosition}
          onChange={(e) => setCurrentSize(calculateSizeValue(Number(e.target.value)))}
        />
        <span className="setting-value">{currentSize}px</span>
      </label>

      <label className="setting">
        <span className="setting-label">Flow</span>
        <PressureToggle
          enabled={pressureFlowEnabled}
          onToggle={togglePressureFlow}
          title="Pressure affects flow"
        />
        <input
          type="range"
          min="0.01"
          max="1"
          step="0.01"
          value={brushFlow}
          onChange={(e) => setBrushFlow(Number(e.target.value))}
        />
        <span className="setting-value">{Math.round(brushFlow * 100)}%</span>
      </label>

      <label className="setting">
        <span className="setting-label">Opacity</span>
        <PressureToggle
          enabled={pressureOpacityEnabled}
          onToggle={togglePressureOpacity}
          title="Pressure affects opacity"
        />
        <input
          type="range"
          min="0.01"
          max="1"
          step="0.01"
          value={brushOpacity}
          onChange={(e) => setBrushOpacity(Number(e.target.value))}
        />
        <span className="setting-value">{Math.round(brushOpacity * 100)}%</span>
      </label>

      <button
        className={`tool-btn ${showCrosshair ? 'active' : ''}`}
        onClick={toggleCrosshair}
        title="Toggle Crosshair (for cursor delay comparison)"
      >
        <Crosshair {...ICON_PROPS} />
      </button>

      <button
        className={`tool-btn ${brushPanelOpen ? 'active' : ''}`}
        onClick={toggleBrushPanel}
        title="Brush Settings"
      >
        <SlidersHorizontal {...ICON_PROPS} />
      </button>
    </div>
  );
}

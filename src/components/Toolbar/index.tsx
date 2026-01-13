import { Undo2, Redo2, ZoomIn, ZoomOut, Crosshair } from 'lucide-react';
import { useToolStore, PressureCurve } from '@/stores/tool';
import { useViewportStore } from '@/stores/viewport';
import { useHistoryStore } from '@/stores/history';
import './Toolbar.css';

/** Common icon props for toolbar icons */
const ICON_PROPS = { size: 18, strokeWidth: 1.5 } as const;

const PRESSURE_CURVES: { id: PressureCurve; label: string }[] = [
  // Pressure curve presets
  { id: 'linear', label: 'Linear' },
  { id: 'soft', label: 'Soft' },
  { id: 'hard', label: 'Hard' },
  { id: 'sCurve', label: 'S-Curve' },
];

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

export function Toolbar() {
  const {
    currentTool,
    brushSize,
    eraserSize,
    setCurrentSize,
    brushFlow,
    setBrushFlow,
    brushOpacity,
    setBrushOpacity,
    pressureCurve,
    setPressureCurve,
    pressureSizeEnabled,
    togglePressureSize,
    pressureFlowEnabled,
    togglePressureFlow,
    pressureOpacityEnabled,
    togglePressureOpacity,
    showCrosshair,
    toggleCrosshair,
  } = useToolStore();

  // Get current tool size (brush or eraser)
  const currentSize = currentTool === 'eraser' ? eraserSize : brushSize;

  const { scale, zoomIn, zoomOut, resetZoom } = useViewportStore();

  const { canUndo, canRedo } = useHistoryStore();

  const zoomPercent = Math.round(scale * 100);

  const handleUndo = () => {
    const win = window as Window & { __canvasUndo?: () => void };
    win.__canvasUndo?.();
  };

  const handleRedo = () => {
    const win = window as Window & { __canvasRedo?: () => void };
    win.__canvasRedo?.();
  };

  return (
    <header className="toolbar">
      <div className="toolbar-divider" />

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
            min="1"
            max="200"
            value={currentSize}
            onChange={(e) => setCurrentSize(Number(e.target.value))}
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

        <label className="setting">
          <span className="setting-label">Curve</span>
          <select
            value={pressureCurve}
            onChange={(e) => setPressureCurve(e.target.value as PressureCurve)}
            className="pressure-select"
          >
            {PRESSURE_CURVES.map((curve) => (
              <option key={curve.id} value={curve.id}>
                {curve.label}
              </option>
            ))}
          </select>
        </label>

        <button
          className={`tool-btn ${showCrosshair ? 'active' : ''}`}
          onClick={toggleCrosshair}
          title="Toggle Crosshair (for cursor delay comparison)"
        >
          <Crosshair {...ICON_PROPS} />
        </button>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-section zoom-controls">
        <button onClick={() => zoomOut()} title="Zoom Out">
          <ZoomOut {...ICON_PROPS} />
        </button>
        <button className="zoom-level" onClick={resetZoom} title="Reset Zoom (100%)">
          {zoomPercent}%
        </button>
        <button onClick={() => zoomIn()} title="Zoom In">
          <ZoomIn {...ICON_PROPS} />
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-section actions">
        <button
          data-testid="undo-btn"
          disabled={!canUndo()}
          onClick={handleUndo}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 {...ICON_PROPS} />
        </button>
        <button
          data-testid="redo-btn"
          disabled={!canRedo()}
          onClick={handleRedo}
          title="Redo (Ctrl+Y)"
        >
          <Redo2 {...ICON_PROPS} />
        </button>
      </div>
    </header>
  );
}

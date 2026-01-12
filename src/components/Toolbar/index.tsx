import {
  Brush,
  Eraser,
  Pipette,
  Move,
  BoxSelect,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  LucideIcon,
} from 'lucide-react';
import { useToolStore, ToolType, PressureCurve } from '@/stores/tool';
import { useViewportStore } from '@/stores/viewport';
import { useHistoryStore } from '@/stores/history';
import './Toolbar.css';

const TOOLS: { id: ToolType; label: string; icon: LucideIcon }[] = [
  { id: 'brush', label: 'Brush', icon: Brush },
  { id: 'eraser', label: 'Eraser', icon: Eraser },
  { id: 'eyedropper', label: 'Eyedropper', icon: Pipette },
  { id: 'move', label: 'Move', icon: Move },
  { id: 'select', label: 'Select', icon: BoxSelect },
];

const PRESSURE_CURVES: { id: PressureCurve; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'soft', label: 'Soft' },
  { id: 'hard', label: 'Hard' },
  { id: 'sCurve', label: 'S-Curve' },
];

export function Toolbar() {
  const {
    currentTool,
    setTool,
    brushSize,
    eraserSize,
    setCurrentSize,
    brushOpacity,
    setBrushOpacity,
    brushColor,
    setBrushColor,
    pressureCurve,
    setPressureCurve,
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
      <div className="toolbar-section tools">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            className={`tool-btn ${currentTool === tool.id ? 'active' : ''}`}
            onClick={() => setTool(tool.id)}
            title={tool.label}
          >
            <tool.icon size={18} strokeWidth={1.5} />
          </button>
        ))}
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-section brush-settings">
        <label className="setting">
          <span className="setting-label">Size</span>
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
          <span className="setting-label">Opacity</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={brushOpacity}
            onChange={(e) => setBrushOpacity(Number(e.target.value))}
          />
          <span className="setting-value">{Math.round(brushOpacity * 100)}%</span>
        </label>

        <label className="setting">
          <span className="setting-label">Pressure</span>
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
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-section color-picker">
        <input
          type="color"
          value={brushColor}
          onChange={(e) => setBrushColor(e.target.value)}
          className="color-input"
          title="Brush Color"
        />
        <span className="color-hex">{brushColor}</span>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-section zoom-controls">
        <button onClick={() => zoomOut()} title="Zoom Out">
          <ZoomOut size={18} strokeWidth={1.5} />
        </button>
        <button className="zoom-level" onClick={resetZoom} title="Reset Zoom (100%)">
          {zoomPercent}%
        </button>
        <button onClick={() => zoomIn()} title="Zoom In">
          <ZoomIn size={18} strokeWidth={1.5} />
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
          <Undo2 size={18} strokeWidth={1.5} />
        </button>
        <button
          data-testid="redo-btn"
          disabled={!canRedo()}
          onClick={handleRedo}
          title="Redo (Ctrl+Y)"
        >
          <Redo2 size={18} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  );
}

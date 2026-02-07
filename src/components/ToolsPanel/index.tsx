import {
  Brush,
  Eraser,
  Pipette,
  Move,
  SquareDashed,
  Lasso,
  ZoomIn as ZoomIcon,
  LucideIcon,
} from 'lucide-react';
import { useToolStore, ToolType } from '@/stores/tool';
import { useViewportStore } from '@/stores/viewport';
import './ToolsPanel.css';

const ICON_PROPS = { size: 24, strokeWidth: 1.5 } as const;

const TOOLS: { id: ToolType; label: string; icon: LucideIcon }[] = [
  { id: 'brush', label: 'Brush (B)', icon: Brush },
  { id: 'eraser', label: 'Eraser (E)', icon: Eraser },
  { id: 'eyedropper', label: 'Eyedropper (Alt)', icon: Pipette },
  { id: 'move', label: 'Move (V)', icon: Move },
  { id: 'select', label: 'Rectangular Select (M)', icon: SquareDashed },
  { id: 'lasso', label: 'Lasso (S)', icon: Lasso },
  { id: 'zoom', label: 'Zoom (Z) - Double-click to reset to 100%', icon: ZoomIcon },
];

export function ToolsPanel() {
  const { currentTool, setTool } = useToolStore();
  const setScale = useViewportStore((s) => s.setScale);

  const handleToolDoubleClick = (toolId: ToolType) => {
    // Double-click on zoom tool resets scale to 100%
    if (toolId === 'zoom') {
      setScale(1);
    }
  };

  return (
    <div className="tools-panel-content">
      {TOOLS.map((tool) => (
        <button
          key={tool.id}
          className={`tool-grid-btn ${currentTool === tool.id ? 'active' : ''}`}
          onClick={() => setTool(tool.id)}
          onDoubleClick={() => handleToolDoubleClick(tool.id)}
          title={tool.label}
        >
          <tool.icon {...ICON_PROPS} />
        </button>
      ))}
    </div>
  );
}

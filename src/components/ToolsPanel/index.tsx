import {
  Brush,
  Eraser,
  Pipette,
  Move,
  BoxSelect,
  ZoomIn as ZoomIcon,
  LucideIcon,
} from 'lucide-react';
import { useToolStore, ToolType } from '@/stores/tool';
import { useViewportStore } from '@/stores/viewport';
import './ToolsPanel.css';

const ICON_PROPS = { size: 24, strokeWidth: 1.5 } as const;

const TOOLS: { id: ToolType; label: string; icon: LucideIcon }[] = [
  { id: 'brush', label: 'Brush', icon: Brush },
  { id: 'eraser', label: 'Eraser', icon: Eraser },
  { id: 'eyedropper', label: 'Eyedropper', icon: Pipette },
  { id: 'move', label: 'Move', icon: Move },
  { id: 'select', label: 'Select', icon: BoxSelect },
  { id: 'zoom', label: 'Zoom (Double-click to reset to 100%)', icon: ZoomIcon },
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

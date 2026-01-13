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
import './ToolsPanel.css';

const ICON_PROPS = { size: 24, strokeWidth: 1.5 } as const;

const TOOLS: { id: ToolType; label: string; icon: LucideIcon }[] = [
  { id: 'brush', label: 'Brush', icon: Brush },
  { id: 'eraser', label: 'Eraser', icon: Eraser },
  { id: 'eyedropper', label: 'Eyedropper', icon: Pipette },
  { id: 'move', label: 'Move', icon: Move },
  { id: 'select', label: 'Select', icon: BoxSelect },
  { id: 'zoom', label: 'Zoom', icon: ZoomIcon },
];

export function ToolsPanel() {
  const { currentTool, setTool } = useToolStore();

  return (
    <div className="tools-panel-content">
      {TOOLS.map((tool) => (
        <button
          key={tool.id}
          className={`tool-grid-btn ${currentTool === tool.id ? 'active' : ''}`}
          onClick={() => setTool(tool.id)}
          title={tool.label}
        >
          <tool.icon {...ICON_PROPS} />
        </button>
      ))}
    </div>
  );
}

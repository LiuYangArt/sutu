/**
 * Left Toolbar - Fixed position, no title bar
 * Contains tool buttons only
 */
import {
  Brush,
  Eraser,
  Pipette,
  Move,
  SquareDashed,
  Lasso,
  ZoomIn as ZoomIcon,
  type LucideProps,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useToolStore, ToolType } from '@/stores/tool';
import { useViewportStore } from '@/stores/viewport';
import { GradientToolIcon } from '@/components/common/GradientToolIcon';
import './SidePanel.css';

const ICON_PROPS = { size: 24, strokeWidth: 1.5 } as const;
type ToolItem = { id: ToolType; label: string; icon: ComponentType<LucideProps> };

const TOOL_SHORTCUTS: Record<ToolType, string> = {
  brush: 'B',
  eraser: 'E',
  eyedropper: 'Alt',
  gradient: 'G',
  move: 'V',
  select: 'M',
  lasso: 'S',
  zoom: 'Z',
};

const TOOLS: ToolItem[] = [
  { id: 'brush', label: 'Brush', icon: Brush },
  { id: 'eraser', label: 'Eraser', icon: Eraser },
  { id: 'eyedropper', label: 'Eyedropper', icon: Pipette },
  { id: 'gradient', label: 'Gradient', icon: GradientToolIcon },
  { id: 'move', label: 'Move', icon: Move },
  { id: 'select', label: 'Rectangular Select', icon: SquareDashed },
  { id: 'lasso', label: 'Lasso', icon: Lasso },
  { id: 'zoom', label: 'Zoom', icon: ZoomIcon },
];

function getToolTooltip(tool: ToolItem): string {
  const shortcut = TOOL_SHORTCUTS[tool.id];
  if (tool.id === 'zoom') {
    return `${tool.label} (${shortcut}) - Double-click to reset to 100%`;
  }
  return `${tool.label} (${shortcut})`;
}

export function LeftToolbar(): JSX.Element {
  const { currentTool, setTool } = useToolStore();
  const setScale = useViewportStore((s) => s.setScale);

  const handleToolDoubleClick = (toolId: ToolType) => {
    if (toolId === 'zoom') {
      setScale(1);
    }
  };

  return (
    <aside className="left-toolbar">
      <div className="toolbar-tools">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            className={`tool-grid-btn ${currentTool === tool.id ? 'active' : ''}`}
            onClick={() => setTool(tool.id)}
            onDoubleClick={() => handleToolDoubleClick(tool.id)}
            title={getToolTooltip(tool)}
          >
            <tool.icon {...ICON_PROPS} />
          </button>
        ))}
      </div>
    </aside>
  );
}

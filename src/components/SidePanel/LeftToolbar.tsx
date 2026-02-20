/**
 * Left Toolbar - Fixed position, no title bar
 * Contains tool buttons only
 */
import {
  Brush,
  Eraser,
  Pipette,
  Move,
  CircleDashed,
  SquareDashed,
  Lasso,
  ZoomIn as ZoomIcon,
  type LucideProps,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useToolStore, ToolType } from '@/stores/tool';
import { useSelectionStore, type SelectionShape } from '@/stores/selection';
import { useViewportStore } from '@/stores/viewport';
import { useI18n } from '@/i18n';
import { GradientToolIcon } from '@/components/common/GradientToolIcon';
import './SidePanel.css';

const ICON_PROPS = { size: 24, strokeWidth: 1.5 } as const;
type ToolItem = { id: ToolType; icon: ComponentType<LucideProps> };

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
  { id: 'brush', icon: Brush },
  { id: 'eraser', icon: Eraser },
  { id: 'eyedropper', icon: Pipette },
  { id: 'gradient', icon: GradientToolIcon },
  { id: 'move', icon: Move },
  { id: 'select', icon: SquareDashed },
  { id: 'lasso', icon: Lasso },
  { id: 'zoom', icon: ZoomIcon },
];

function getToolTooltip(tool: ToolItem, t: (key: string) => string): string {
  const shortcut = TOOL_SHORTCUTS[tool.id];
  if (tool.id === 'zoom') {
    return `${t(`leftToolbar.tool.${tool.id}`)} (${shortcut}) - ${t('leftToolbar.zoomDoubleClickHint')}`;
  }
  return `${t(`leftToolbar.tool.${tool.id}`)} (${shortcut})`;
}

function getToolIcon(tool: ToolItem, selectionShape: SelectionShape): ComponentType<LucideProps> {
  if (tool.id !== 'select') {
    return tool.icon;
  }
  if (selectionShape === 'circle') {
    return CircleDashed;
  }
  return SquareDashed;
}

export function LeftToolbar(): JSX.Element {
  const { t } = useI18n();
  const { currentTool, setTool } = useToolStore();
  const selectionShape = useSelectionStore((s) => s.selectionShape);
  const setScale = useViewportStore((s) => s.setScale);

  const handleToolDoubleClick = (toolId: ToolType) => {
    if (toolId === 'zoom') {
      setScale(1);
    }
  };

  return (
    <aside className="left-toolbar">
      <div className="toolbar-tools">
        {TOOLS.map((tool) => {
          const IconComponent = getToolIcon(tool, selectionShape);
          return (
            <button
              key={tool.id}
              className={`tool-grid-btn ${currentTool === tool.id ? 'active' : ''}`}
              onClick={() => setTool(tool.id)}
              onDoubleClick={() => handleToolDoubleClick(tool.id)}
              title={getToolTooltip(tool, t)}
            >
              <IconComponent {...ICON_PROPS} />
            </button>
          );
        })}
      </div>
    </aside>
  );
}

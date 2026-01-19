import { usePanelStore } from '../../stores/panel';
import { FloatingPanel } from './FloatingPanel';
import React from 'react';
import { useShallow } from 'zustand/react/shallow';

// Registry of available floating panel contents
// Tools, Color, Layer panels are now fixed - only Brush uses FloatingPanel
import { BrushPanel } from '../BrushPanel';

const PANEL_REGISTRY: Record<string, React.FC> = {
  'brush-panel': BrushPanel,
  'debug-panel': () => <div style={{ padding: 10, color: '#ccc' }}>Debug Info Content</div>,
};

export function PanelLayer() {
  // Only render panels that are both open AND registered in PANEL_REGISTRY
  // This prevents old localStorage data from rendering removed panels
  const panelIds = usePanelStore(
    useShallow((s) =>
      Object.keys(s.panels).filter((id) => s.panels[id]?.isOpen && PANEL_REGISTRY[id] !== undefined)
    )
  );

  const configs = usePanelStore((s) => s.configs);

  return (
    <>
      {panelIds.map((id) => {
        const config = configs[id];
        const Component = PANEL_REGISTRY[id];

        if (!Component) return null;

        return (
          <FloatingPanel
            key={id}
            panelId={id}
            title={config?.title}
            minWidth={config?.minWidth}
            minHeight={config?.minHeight}
          >
            <Component />
          </FloatingPanel>
        );
      })}
    </>
  );
}

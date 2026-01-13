import { usePanelStore } from '../../stores/panel';
import { FloatingPanel } from './FloatingPanel';
import React from 'react';
import { useShallow } from 'zustand/react/shallow';

// Registry of available panel contents
// In a real app, this might be dynamic or injected
import { ColorPanel } from '../ColorPanel';
import { LayerPanel } from '../LayerPanel';
import { ToolsPanel } from '../ToolsPanel';
import { BrushPanel } from '../BrushPanel';

const PANEL_REGISTRY: Record<string, React.FC> = {
  'color-panel': ColorPanel,
  'layer-panel': LayerPanel,
  'tools-panel': ToolsPanel,
  'brush-panel': BrushPanel,
  // Add more generic panels here
  'debug-panel': () => <div style={{ padding: 10, color: '#ccc' }}>Debug Info Content</div>,
};

export function PanelLayer() {
  // Only subscribe to the list of panel IDs and their open status to determine what to render
  // The panels themselves are responsible for their own geometry/state via their own hooks
  const panelIds = usePanelStore(
    useShallow((s) => Object.keys(s.panels).filter((id) => s.panels[id]?.isOpen))
  );

  const configs = usePanelStore((s) => s.configs);

  return (
    <>
      {panelIds.map((id) => {
        const config = configs[id];
        const Component = PANEL_REGISTRY[id];

        return (
          <FloatingPanel
            key={id}
            panelId={id}
            title={config?.title}
            minWidth={config?.minWidth}
            minHeight={config?.minHeight}
          >
            {Component ? <Component /> : <div>Panel Content Missing for {id}</div>}
          </FloatingPanel>
        );
      })}
    </>
  );
}

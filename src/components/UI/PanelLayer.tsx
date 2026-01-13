import { usePanelStore } from '../../stores/panel';
import { FloatingPanel } from './FloatingPanel';
import React from 'react';

// Registry of available panel contents
// In a real app, this might be dynamic or injected
import { ColorPanel } from '../ColorPanel';
import { LayerPanel } from '../LayerPanel';

const PANEL_REGISTRY: Record<string, React.FC> = {
  'color-panel': ColorPanel,
  'layer-panel': LayerPanel,
  // Add more generic panels here
  'debug-panel': () => <div style={{ padding: 10, color: '#ccc' }}>Debug Info Content</div>,
};

export function PanelLayer() {
  const panels = usePanelStore((s) => s.panels);
  const configs = usePanelStore((s) => s.configs);

  return (
    <>
      {Object.values(panels).map((panel) => {
        if (!panel.isOpen) return null;

        const config = configs[panel.id];
        const Component = PANEL_REGISTRY[panel.id];

        // If no component registered, maybe generic content or skip
        // For M7.1 we want to verify the System.

        return (
          <FloatingPanel
            key={panel.id}
            panelId={panel.id}
            title={config?.title}
            minWidth={config?.minWidth}
            minHeight={config?.minHeight}
          >
            {Component ? <Component /> : <div>Panel Content Missing for {panel.id}</div>}
          </FloatingPanel>
        );
      })}
    </>
  );
}

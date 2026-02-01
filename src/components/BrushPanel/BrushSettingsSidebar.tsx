import React from 'react';
import { useToolStore } from '@/stores/tool';
import { useShallow } from 'zustand/react/shallow';

export interface TabConfig {
  id: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

interface BrushSettingsSidebarProps {
  tabs: TabConfig[];
  activeTabId: string;
  onTabSelect: (id: string) => void;
}

export function BrushSettingsSidebar({
  tabs,
  activeTabId,
  onTabSelect,
}: BrushSettingsSidebarProps): JSX.Element {
  // Select all toggle states and actions
  const {
    shapeDynamicsEnabled,
    toggleShapeDynamics,
    scatterEnabled,
    toggleScatter,
    textureEnabled,
    toggleTexture,
    dualBrushEnabled,
    toggleDualBrush,
    colorDynamicsEnabled,
    toggleColorDynamics,
    transferEnabled,
    toggleTransfer,
    wetEdgeEnabled,
    toggleWetEdge,
  } = useToolStore(
    useShallow((s) => ({
      shapeDynamicsEnabled: s.shapeDynamicsEnabled,
      toggleShapeDynamics: s.toggleShapeDynamics,
      scatterEnabled: s.scatterEnabled,
      toggleScatter: s.toggleScatter,
      textureEnabled: s.textureEnabled,
      toggleTexture: s.toggleTexture,
      dualBrushEnabled: s.dualBrushEnabled,
      toggleDualBrush: s.toggleDualBrush,
      colorDynamicsEnabled: s.colorDynamicsEnabled,
      toggleColorDynamics: s.toggleColorDynamics,
      transferEnabled: s.transferEnabled,
      toggleTransfer: s.toggleTransfer,
      wetEdgeEnabled: s.wetEdgeEnabled,
      toggleWetEdge: s.toggleWetEdge,
    }))
  );

  const getToggleState = (id: string) => {
    switch (id) {
      case 'shape_dynamics':
        return { checked: shapeDynamicsEnabled, onChange: toggleShapeDynamics };
      case 'scattering':
        return { checked: scatterEnabled, onChange: toggleScatter };
      case 'texture':
        return { checked: textureEnabled, onChange: toggleTexture };
      case 'dual_brush':
        return { checked: dualBrushEnabled, onChange: toggleDualBrush };
      case 'color_dynamics':
        return { checked: colorDynamicsEnabled, onChange: toggleColorDynamics };
      case 'transfer':
        return { checked: transferEnabled, onChange: toggleTransfer };
      case 'wet_edges':
        return { checked: wetEdgeEnabled, onChange: toggleWetEdge };
      default:
        return null;
    }
  };

  return (
    <div className="brush-sidebar">
      {tabs.map((tab) => {
        const toggle = getToggleState(tab.id);
        const hasCheckbox = toggle !== null;

        return (
          <div
            key={tab.id}
            className={`sidebar-item ${activeTabId === tab.id ? 'active' : ''} ${
              tab.disabled ? 'disabled' : ''
            }`}
            onClick={() => !tab.disabled && onTabSelect(tab.id)}
            title={tab.disabled ? 'Coming Soon' : tab.label}
          >
            {hasCheckbox ? (
              <input
                type="checkbox"
                checked={toggle.checked}
                onChange={(e) => {
                  e.stopPropagation();
                  toggle.onChange();
                }}
                disabled={tab.disabled}
                className="sidebar-checkbox"
              />
            ) : (
              // Spacer to align tabs without checkbox
              <div className="sidebar-checkbox-spacer" />
            )}
            <span className="sidebar-label">{tab.label}</span>
            {/* Lock icon could go here */}
          </div>
        );
      })}
    </div>
  );
}

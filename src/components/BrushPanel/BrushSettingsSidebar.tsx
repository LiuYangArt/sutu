import React from 'react';
import { useToolStore } from '@/stores/tool';
import { usePatternLibraryStore } from '@/stores/pattern';
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
  onSave: () => void;
  onSaveAs: () => void;
}

export function BrushSettingsSidebar({
  tabs,
  activeTabId,
  onTabSelect,
  onSave,
  onSaveAs,
}: BrushSettingsSidebarProps): JSX.Element {
  // Select all toggle states and actions
  const {
    shapeDynamicsEnabled,
    toggleShapeDynamics,
    scatterEnabled,
    toggleScatter,
    textureEnabled,
    texturePatternId,
    setTextureEnabled,
    noiseEnabled,
    toggleNoise,
    dualBrushEnabled,
    toggleDualBrush,
    colorDynamicsEnabled,
    toggleColorDynamics,
    transferEnabled,
    toggleTransfer,
    wetEdgeEnabled,
    toggleWetEdge,
    buildupEnabled,
    toggleBuildup,
  } = useToolStore(
    useShallow((s) => ({
      shapeDynamicsEnabled: s.shapeDynamicsEnabled,
      toggleShapeDynamics: s.toggleShapeDynamics,
      scatterEnabled: s.scatterEnabled,
      toggleScatter: s.toggleScatter,
      textureEnabled: s.textureEnabled,
      texturePatternId: s.textureSettings.patternId,
      setTextureEnabled: s.setTextureEnabled,
      noiseEnabled: s.noiseEnabled,
      toggleNoise: s.toggleNoise,
      dualBrushEnabled: s.dualBrushEnabled,
      toggleDualBrush: s.toggleDualBrush,
      colorDynamicsEnabled: s.colorDynamicsEnabled,
      toggleColorDynamics: s.toggleColorDynamics,
      transferEnabled: s.transferEnabled,
      toggleTransfer: s.toggleTransfer,
      wetEdgeEnabled: s.wetEdgeEnabled,
      toggleWetEdge: s.toggleWetEdge,
      buildupEnabled: s.buildupEnabled,
      toggleBuildup: s.toggleBuildup,
    }))
  );
  const loadPatterns = usePatternLibraryStore((s) => s.loadPatterns);

  const handleTextureToggle = async (): Promise<void> => {
    const willEnable = !textureEnabled;
    if (!willEnable) {
      setTextureEnabled(false);
      return;
    }

    setTextureEnabled(true);
    if (texturePatternId) {
      return;
    }

    let libraryPatterns = usePatternLibraryStore.getState().patterns;
    if (libraryPatterns.length === 0) {
      try {
        await loadPatterns();
      } catch (error) {
        console.warn(
          '[BrushSettingsSidebar] Failed to load patterns when enabling texture panel:',
          error
        );
        return;
      }
      libraryPatterns = usePatternLibraryStore.getState().patterns;
    }

    const firstPatternId = libraryPatterns[0]?.id;
    if (!firstPatternId) {
      return;
    }

    const latestToolState = useToolStore.getState();
    if (!latestToolState.textureEnabled || latestToolState.textureSettings.patternId) {
      return;
    }
    latestToolState.setTextureSettings({ patternId: firstPatternId });
  };

  const toggleMap: Record<string, { checked: boolean; onChange: () => void }> = {
    shape_dynamics: { checked: shapeDynamicsEnabled, onChange: toggleShapeDynamics },
    scattering: { checked: scatterEnabled, onChange: toggleScatter },
    texture: { checked: textureEnabled, onChange: () => void handleTextureToggle() },
    noise: { checked: noiseEnabled, onChange: toggleNoise },
    dual_brush: { checked: dualBrushEnabled, onChange: toggleDualBrush },
    color_dynamics: { checked: colorDynamicsEnabled, onChange: toggleColorDynamics },
    transfer: { checked: transferEnabled, onChange: toggleTransfer },
    wet_edges: { checked: wetEdgeEnabled, onChange: toggleWetEdge },
    build_up: { checked: buildupEnabled, onChange: toggleBuildup },
  };

  return (
    <div className="brush-sidebar">
      <div className="brush-sidebar-tabs">
        {tabs.map((tab) => {
          const toggle = toggleMap[tab.id] ?? null;
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

      <div className="brush-sidebar-actions">
        <button className="brush-sidebar-action-btn" onClick={onSave}>
          Save
        </button>
        <button className="brush-sidebar-action-btn" onClick={onSaveAs}>
          Save As
        </button>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import './BrushPanel.css';
import { BrushSettingsSidebar, TabConfig } from './BrushSettingsSidebar';
import { BrushTipShape } from './settings/BrushTipShape';
import { TransferSettings } from './settings/TransferSettings';
import { ShapeDynamicsSettings } from './settings/ShapeDynamicsSettings';
import { ScatterSettings } from './settings/ScatterSettings';
import { ColorDynamicsSettings } from './settings/ColorDynamicsSettings';
import { WetEdgeSettings } from './settings/WetEdgeSettings';
import { TextureSettings } from './settings/TextureSettings';
import { DualBrushSettings } from './settings/DualBrushSettings';
import { BuildupSettings } from './settings/BuildupSettings';
import { NoiseSettings } from './settings/NoiseSettings';
import { useBrushLibraryStore, useSelectedPresetIdForCurrentTool } from '@/stores/brushLibrary';

interface PresetDialogResult {
  name: string;
  group: string | null;
}

function promptPresetInfo(
  defaultName: string,
  defaultGroup: string | null | undefined
): PresetDialogResult | null {
  const name = window.prompt('Preset name', defaultName)?.trim();
  if (!name) {
    return null;
  }

  const group = window.prompt('Group name (optional)', defaultGroup ?? '')?.trim();
  return {
    name,
    group: group || null,
  };
}

export function BrushPanel(): JSX.Element {
  const [activeTab, setActiveTab] = useState('tip_shape');
  const loadLibrary = useBrushLibraryStore((state) => state.loadLibrary);
  const presets = useBrushLibraryStore((state) => state.presets);
  const selectedPresetId = useSelectedPresetIdForCurrentTool();
  const saveActivePreset = useBrushLibraryStore((state) => state.saveActivePreset);
  const saveActivePresetAs = useBrushLibraryStore((state) => state.saveActivePresetAs);
  const setSelectedPresetId = useBrushLibraryStore((state) => state.setSelectedPresetId);

  const activePreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? null,
    [presets, selectedPresetId]
  );

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  // Tab Configuration - Renderer moved to Settings panel
  const tabs: TabConfig[] = [
    { id: 'tip_shape', label: 'Brush Tip Shape' },
    { id: 'shape_dynamics', label: 'Shape Dynamics' },
    { id: 'scattering', label: 'Scattering' },
    { id: 'texture', label: 'Texture' },
    { id: 'dual_brush', label: 'Dual Brush' },
    { id: 'color_dynamics', label: 'Color Dynamics' },
    { id: 'transfer', label: 'Transfer' },
    { id: 'brush_pose', label: 'Brush Pose', disabled: true },
    { id: 'noise', label: 'Noise' },
    { id: 'wet_edges', label: 'Wet Edges' },
    { id: 'build_up', label: 'Build-up' },
    { id: 'smoothing', label: 'Smoothing', disabled: true },
    { id: 'protect_texture', label: 'Protect Texture', disabled: true },
  ];

  const tabContentMap: Record<string, JSX.Element> = {
    tip_shape: <BrushTipShape />,
    shape_dynamics: <ShapeDynamicsSettings />,
    scattering: <ScatterSettings />,
    texture: <TextureSettings />,
    dual_brush: <DualBrushSettings />,
    color_dynamics: <ColorDynamicsSettings />,
    wet_edges: <WetEdgeSettings />,
    build_up: <BuildupSettings />,
    transfer: <TransferSettings />,
    noise: <NoiseSettings />,
  };

  const renderContent = () => {
    const content = tabContentMap[activeTab];
    if (content) {
      return content;
    }

    return (
      <div className="p-4 text-gray-500 text-sm">
        Section &quot;{tabs.find((t) => t.id === activeTab)?.label}&quot; is coming soon.
      </div>
    );
  };

  const handleSave = async () => {
    try {
      const saved = await saveActivePreset();
      if (!saved) {
        const presetInfo = promptPresetInfo(
          activePreset?.name ?? 'New Brush Preset',
          activePreset?.group
        );
        if (!presetInfo) return;
        await saveActivePresetAs(presetInfo.name, presetInfo.group);
        return;
      }

      setSelectedPresetId(saved.id);
    } catch (err) {
      console.error('[BrushPanel] save failed', err);
    }
  };

  const handleSaveAs = async () => {
    try {
      const defaultName = activePreset?.name ? `${activePreset.name} Copy` : 'New Brush Preset';
      const presetInfo = promptPresetInfo(defaultName, activePreset?.group);
      if (!presetInfo) {
        return;
      }

      await saveActivePresetAs(presetInfo.name, presetInfo.group);
    } catch (err) {
      console.error('[BrushPanel] save as failed', err);
    }
  };

  return (
    <div className="brush-panel-container">
      <BrushSettingsSidebar
        tabs={tabs}
        activeTabId={activeTab}
        onTabSelect={setActiveTab}
        onSave={() => void handleSave()}
        onSaveAs={() => void handleSaveAs()}
      />
      <div className="brush-content brush-panel">{renderContent()}</div>
    </div>
  );
}

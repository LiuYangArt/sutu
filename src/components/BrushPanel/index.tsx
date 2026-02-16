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
import { useI18n } from '@/i18n';

interface PresetDialogResult {
  name: string;
  group: string | null;
}

function promptPresetInfo(
  promptNameLabel: string,
  promptGroupLabel: string,
  defaultName: string,
  defaultGroup: string | null | undefined
): PresetDialogResult | null {
  const name = window.prompt(promptNameLabel, defaultName)?.trim();
  if (!name) {
    return null;
  }

  const group = window.prompt(promptGroupLabel, defaultGroup ?? '')?.trim();
  return {
    name,
    group: group || null,
  };
}

export function BrushPanel(): JSX.Element {
  const { t } = useI18n();
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
    { id: 'tip_shape', label: t('brushPanel.tab.tipShape') },
    { id: 'shape_dynamics', label: t('brushPanel.tab.shapeDynamics') },
    { id: 'scattering', label: t('brushPanel.tab.scattering') },
    { id: 'texture', label: t('brushPanel.tab.texture') },
    { id: 'dual_brush', label: t('brushPanel.tab.dualBrush') },
    { id: 'color_dynamics', label: t('brushPanel.tab.colorDynamics') },
    { id: 'transfer', label: t('brushPanel.tab.transfer') },
    { id: 'brush_pose', label: t('brushPanel.tab.brushPose'), disabled: true },
    { id: 'noise', label: t('brushPanel.tab.noise') },
    { id: 'wet_edges', label: t('brushPanel.tab.wetEdges') },
    { id: 'build_up', label: t('brushPanel.tab.buildUp') },
    { id: 'smoothing', label: t('brushPanel.tab.smoothing'), disabled: true },
    { id: 'protect_texture', label: t('brushPanel.tab.protectTexture'), disabled: true },
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
        {t('brushPanel.sectionComingSoon', {
          section: tabs.find((t) => t.id === activeTab)?.label ?? '',
        })}
      </div>
    );
  };

  const handleSave = async () => {
    try {
      const saved = await saveActivePreset();
      if (!saved) {
        const presetInfo = promptPresetInfo(
          t('brushPanel.prompt.presetName'),
          t('brushPanel.prompt.groupNameOptional'),
          activePreset?.name ?? t('brushPanel.defaultNewBrushPreset'),
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
      const defaultName = activePreset?.name
        ? `${activePreset.name} ${t('brushPanel.copySuffix')}`
        : t('brushPanel.defaultNewBrushPreset');
      const presetInfo = promptPresetInfo(
        t('brushPanel.prompt.presetName'),
        t('brushPanel.prompt.groupNameOptional'),
        defaultName,
        activePreset?.group
      );
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

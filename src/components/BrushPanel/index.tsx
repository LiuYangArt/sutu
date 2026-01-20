import { useState } from 'react';
import './BrushPanel.css';
import { BrushPreset } from './types';
import { BrushSettingsSidebar, TabConfig } from './BrushSettingsSidebar';
import { BrushPresets } from './settings/BrushPresets';
import { BrushTipShape } from './settings/BrushTipShape';
import { TransferSettings } from './settings/TransferSettings';
import { ShapeDynamicsSettings } from './settings/ShapeDynamicsSettings';

export function BrushPanel(): JSX.Element {
  const [activeTab, setActiveTab] = useState('brushes');
  const [importedPresets, setImportedPresets] = useState<BrushPreset[]>([]);

  // Tab Configuration - Renderer moved to Settings panel
  const tabs: TabConfig[] = [
    { id: 'brushes', label: 'Brushes' },
    { id: 'tip_shape', label: 'Brush Tip Shape' },
    { id: 'shape_dynamics', label: 'Shape Dynamics' },
    { id: 'scattering', label: 'Scattering', disabled: true },
    { id: 'texture', label: 'Texture', disabled: true },
    { id: 'dual_brush', label: 'Dual Brush', disabled: true },
    { id: 'color_dynamics', label: 'Color Dynamics', disabled: true },
    { id: 'transfer', label: 'Transfer' },
    { id: 'brush_pose', label: 'Brush Pose', disabled: true },
    { id: 'noise', label: 'Noise', disabled: true },
    { id: 'wet_edges', label: 'Wet Edges', disabled: true },
    { id: 'build_up', label: 'Build-up', disabled: true },
    { id: 'smoothing', label: 'Smoothing', disabled: true },
    { id: 'protect_texture', label: 'Protect Texture', disabled: true },
  ];

  const renderContent = () => {
    switch (activeTab) {
      case 'brushes':
        return (
          <BrushPresets importedPresets={importedPresets} setImportedPresets={setImportedPresets} />
        );
      case 'tip_shape':
        return <BrushTipShape />;
      case 'shape_dynamics':
        return <ShapeDynamicsSettings />;
      case 'transfer':
        return <TransferSettings />;
      default:
        return (
          <div className="p-4 text-gray-500 text-sm">
            Section &quot;{tabs.find((t) => t.id === activeTab)?.label}&quot; is coming soon.
          </div>
        );
    }
  };

  return (
    <div className="brush-panel-container">
      <BrushSettingsSidebar tabs={tabs} activeTabId={activeTab} onTabSelect={setActiveTab} />
      <div className="brush-content brush-panel">{renderContent()}</div>
    </div>
  );
}

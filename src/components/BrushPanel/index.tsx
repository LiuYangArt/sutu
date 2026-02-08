import { useEffect, useState } from 'react';
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
import { useBrushLibraryStore } from '@/stores/brushLibrary';

export function BrushPanel(): JSX.Element {
  const [activeTab, setActiveTab] = useState('tip_shape');
  const loadLibrary = useBrushLibraryStore((state) => state.loadLibrary);

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

  const renderContent = () => {
    switch (activeTab) {
      case 'tip_shape':
        return <BrushTipShape />;
      case 'shape_dynamics':
        return <ShapeDynamicsSettings />;
      case 'scattering':
        return <ScatterSettings />;
      case 'texture':
        return <TextureSettings />;
      case 'dual_brush':
        return <DualBrushSettings />;
      case 'color_dynamics':
        return <ColorDynamicsSettings />;
      case 'wet_edges':
        return <WetEdgeSettings />;
      case 'build_up':
        return <BuildupSettings />;
      case 'transfer':
        return <TransferSettings />;
      case 'noise':
        return <NoiseSettings />;
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

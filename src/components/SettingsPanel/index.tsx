import { X, Palette, Tablet } from 'lucide-react';
import {
  useSettingsStore,
  ACCENT_COLORS,
  PANEL_BG_COLORS,
  AccentColorId,
  PanelBgColorId,
} from '@/stores/settings';
import { useTabletStore, BackendType } from '@/stores/tablet';
import './SettingsPanel.css';

// Tab configuration
interface TabConfig {
  id: string;
  label: string;
  icon: React.ReactNode;
}

const TABS: TabConfig[] = [
  { id: 'appearance', label: 'Appearance', icon: <Palette size={16} /> },
  { id: 'tablet', label: 'Tablet', icon: <Tablet size={16} /> },
];

// Sidebar component
function SettingsSidebar({
  tabs,
  activeTabId,
  onTabSelect,
}: {
  tabs: TabConfig[];
  activeTabId: string;
  onTabSelect: (id: string) => void;
}) {
  return (
    <div className="settings-sidebar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`settings-sidebar-item ${activeTabId === tab.id ? 'active' : ''}`}
          onClick={() => onTabSelect(tab.id)}
        >
          {tab.icon}
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );
}

// Color swatch component
function ColorSwatch({
  color,
  isSelected,
  onClick,
}: {
  color: string;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`color-swatch ${isSelected ? 'selected' : ''}`}
      style={{ backgroundColor: color }}
      onClick={onClick}
    >
      {isSelected && <span className="check-mark">✓</span>}
    </button>
  );
}

// Appearance settings tab
function AppearanceSettings() {
  const { appearance, setAccentColor, setPanelBgColor, setEnableBlur } = useSettingsStore();

  return (
    <div className="settings-content">
      <h3 className="settings-section-title">Appearance</h3>

      {/* Accent Color */}
      <div className="settings-section">
        <label className="settings-label">ACCENT COLOR</label>
        <div className="color-grid">
          {ACCENT_COLORS.map((color) => (
            <ColorSwatch
              key={color.id}
              color={color.value}
              isSelected={appearance.accentColor === color.id}
              onClick={() => setAccentColor(color.id as AccentColorId)}
            />
          ))}
        </div>
      </div>

      {/* Panel Background */}
      <div className="settings-section">
        <label className="settings-label">PANEL BACKGROUND</label>
        <div className="color-grid">
          {PANEL_BG_COLORS.map((color) => (
            <ColorSwatch
              key={color.id}
              color={color.solid}
              isSelected={appearance.panelBgColor === color.id}
              onClick={() => setPanelBgColor(color.id as PanelBgColorId)}
            />
          ))}
        </div>
      </div>

      {/* Blur Effect Toggle */}
      <div className="settings-section">
        <label className="settings-label">BLUR EFFECT</label>
        <div className="settings-row">
          <span className="settings-description">Enable panel transparency and blur</span>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={appearance.enableBlur}
              onChange={(e) => setEnableBlur(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>
    </div>
  );
}

// Tablet settings tab
function TabletSettings() {
  const { tablet, setTabletBackend, setPollingRate, setPressureCurve, setAutoStart } =
    useSettingsStore();

  const { status, backend, info, isInitialized, isStreaming, init, start, stop, refresh } =
    useTabletStore();

  const statusColor = status === 'Connected' ? '#4f4' : status === 'Error' ? '#f44' : '#888';

  const handleInit = async () => {
    await init({
      backend: tablet.backend,
      pollingRate: tablet.pollingRate,
      pressureCurve: tablet.pressureCurve,
    });
    if (tablet.autoStart) {
      await start();
    }
  };

  const handleToggleStream = async () => {
    if (isStreaming) {
      await stop();
    } else {
      await start();
    }
  };

  return (
    <div className="settings-content">
      <h3 className="settings-section-title">Tablet</h3>

      {/* Status */}
      <div className="settings-section">
        <label className="settings-label">STATUS</label>
        <div className="tablet-status-info">
          <div className="status-row">
            <span>Status:</span>
            <span style={{ color: statusColor }}>{status}</span>
          </div>
          {info && (
            <>
              <div className="status-row">
                <span>Device:</span>
                <span>{info.name}</span>
              </div>
              <div className="status-row">
                <span>Backend:</span>
                <span>{backend}</span>
              </div>
              <div className="status-row">
                <span>Pressure Range:</span>
                <span>
                  {info.pressure_range[0]} - {info.pressure_range[1]}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Configuration (only before init) */}
      {!isInitialized && (
        <div className="settings-section">
          <label className="settings-label">CONFIGURATION</label>

          <div className="settings-row">
            <span>Backend:</span>
            <select
              className="settings-select"
              value={tablet.backend}
              onChange={(e) => setTabletBackend(e.target.value as BackendType)}
            >
              <option value="auto">Auto (prefer WinTab)</option>
              <option value="wintab">WinTab only</option>
              <option value="pointerevent">PointerEvent only</option>
            </select>
          </div>

          <div className="settings-row">
            <span>Polling Rate:</span>
            <select
              className="settings-select"
              value={tablet.pollingRate}
              onChange={(e) => setPollingRate(Number(e.target.value))}
            >
              <option value={100}>100 Hz</option>
              <option value={200}>200 Hz</option>
              <option value={500}>500 Hz</option>
              <option value={1000}>1000 Hz</option>
            </select>
          </div>

          <div className="settings-row">
            <span>Pressure Curve:</span>
            <select
              className="settings-select"
              value={tablet.pressureCurve}
              onChange={(e) =>
                setPressureCurve(e.target.value as 'linear' | 'soft' | 'hard' | 'scurve')
              }
            >
              <option value="linear">Linear</option>
              <option value="soft">Soft</option>
              <option value="hard">Hard</option>
              <option value="scurve">S-Curve</option>
            </select>
          </div>

          <div className="settings-row">
            <span>Auto-start on init:</span>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={tablet.autoStart}
                onChange={(e) => setAutoStart(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="settings-section">
        <label className="settings-label">ACTIONS</label>
        <div className="settings-actions">
          {!isInitialized ? (
            <button className="settings-btn primary" onClick={handleInit}>
              Initialize Tablet
            </button>
          ) : (
            <>
              <button
                className={`settings-btn ${isStreaming ? 'danger' : 'primary'}`}
                onClick={handleToggleStream}
              >
                {isStreaming ? 'Stop' : 'Start'}
              </button>
              <button className="settings-btn" onClick={refresh}>
                Refresh
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Main Settings Panel
export function SettingsPanel() {
  const { isOpen, activeTab, closeSettings, setActiveTab } = useSettingsStore();

  if (!isOpen) return null;

  const renderContent = () => {
    switch (activeTab) {
      case 'appearance':
        return <AppearanceSettings />;
      case 'tablet':
        return <TabletSettings />;
      default:
        return <AppearanceSettings />;
    }
  };

  return (
    <div className="settings-overlay" onClick={closeSettings}>
      <div className="settings-panel mica-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close-btn" onClick={closeSettings}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="settings-body">
          <SettingsSidebar tabs={TABS} activeTabId={activeTab} onTabSelect={setActiveTab} />
          <div className="settings-main">{renderContent()}</div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { X, Palette, Tablet, Brush, Settings2 } from 'lucide-react';
import {
  useSettingsStore,
  ACCENT_COLORS,
  PANEL_BG_COLORS,
  CANVAS_BG_COLORS,
  AccentColorId,
  PanelBgColorId,
  CanvasBgColorId,
  RenderMode,
  GPURenderScaleMode,
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
  { id: 'general', label: 'General', icon: <Settings2 size={16} /> },
  { id: 'brush', label: 'Brush', icon: <Brush size={16} /> },
  { id: 'tablet', label: 'Tablet', icon: <Tablet size={16} /> },
];

const WINDOWS_INK_SETTINGS_PATH = 'Settings > Bluetooth & devices > Pen & Windows Ink';
const WINDOWS_INK_DISABLE_OPTIONS = [
  'Show visual effects',
  'Display additional keys pressed when using my pen',
  'Enable press and hold to perform a right-click equivalent',
];

function getTabletStatusColor(status: string): string {
  if (status === 'Connected') return '#4f4';
  if (status === 'Error') return '#f44';
  return '#888';
}

interface PointerEventDiagnosticsSnapshot {
  eventType: string;
  pointerId: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  normalizedTiltX: number;
  normalizedTiltY: number;
  twist: number;
  altitudeAngleRad: number | null;
  azimuthAngleRad: number | null;
  buttons: number;
  isPrimary: boolean;
  timeStamp: number;
}

function clampSignedUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function normalizeTiltDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clampSignedUnit(value / 90);
}

function toFixed(value: number, digits: number = 3): string {
  if (!Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

function toDegreesString(rad: number | null): string {
  if (rad === null || !Number.isFinite(rad)) return '-';
  return ((rad * 180) / Math.PI).toFixed(1);
}

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
      className={`settings-color-swatch ${isSelected ? 'selected' : ''}`}
      style={{ backgroundColor: color }}
      onClick={onClick}
    >
      {isSelected && <span className="check-mark">✓</span>}
    </button>
  );
}

// Appearance settings tab
function AppearanceSettings() {
  const { appearance, setAccentColor, setPanelBgColor, setCanvasBgColor, setEnableBlur } =
    useSettingsStore();

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

      {/* Canvas Background */}
      <div className="settings-section">
        <label className="settings-label">CANVAS BACKGROUND</label>
        <div className="color-grid">
          {CANVAS_BG_COLORS.map((color) => (
            <ColorSwatch
              key={color.id}
              color={color.value}
              isSelected={appearance.canvasBgColor === color.id}
              onClick={() => setCanvasBgColor(color.id as CanvasBgColorId)}
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

function GeneralSettings() {
  const general = useSettingsStore((s) => s.general);
  const setAutosaveIntervalMinutes = useSettingsStore((s) => s.setAutosaveIntervalMinutes);
  const setOpenLastFileOnStartup = useSettingsStore((s) => s.setOpenLastFileOnStartup);
  const [intervalInput, setIntervalInput] = useState(String(general.autosaveIntervalMinutes));

  useEffect(() => {
    setIntervalInput(String(general.autosaveIntervalMinutes));
  }, [general.autosaveIntervalMinutes]);

  const commitInterval = () => {
    const parsed = Number.parseInt(intervalInput, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setIntervalInput(String(general.autosaveIntervalMinutes));
      return;
    }
    const normalized = Math.max(1, parsed);
    setAutosaveIntervalMinutes(normalized);
    setIntervalInput(String(normalized));
  };

  return (
    <div className="settings-content">
      <h3 className="settings-section-title">General</h3>

      <div className="settings-section">
        <label className="settings-label">AUTO SAVE</label>
        <div className="settings-row">
          <span className="settings-description">Autosave interval (minutes)</span>
          <input
            type="number"
            min={1}
            step={1}
            className="settings-number-input"
            value={intervalInput}
            onChange={(e) => setIntervalInput(e.target.value)}
            onBlur={commitInterval}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitInterval();
              }
            }}
          />
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">STARTUP</label>
        <div className="settings-row">
          <span className="settings-description">Open last file on startup</span>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={general.openLastFileOnStartup}
              onChange={(e) => setOpenLastFileOnStartup(e.target.checked)}
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
  const { tablet, setTabletBackend, setPollingRate, setAutoStart, setPressureCurve } =
    useSettingsStore();

  const {
    status,
    backend,
    info,
    isInitialized,
    isStreaming,
    init,
    switchBackend,
    start,
    stop,
    refresh,
  } = useTabletStore();

  const statusColor = getTabletStatusColor(status);
  const [pointerDiag, setPointerDiag] = useState<PointerEventDiagnosticsSnapshot | null>(null);
  const backendLower = typeof backend === 'string' ? backend.toLowerCase() : 'none';
  const isWinTabActive =
    backendLower === 'wintab' || (backendLower !== 'pointerevent' && tablet.backend === 'wintab');
  const toggleTargetBackend: BackendType = isWinTabActive ? 'pointerevent' : 'wintab';
  const toggleBackendLabel = isWinTabActive ? 'Use PointerEvent' : 'Use WinTab';

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

  const handleToggleBackend = async () => {
    const switched = await switchBackend(toggleTargetBackend, {
      pollingRate: tablet.pollingRate,
      pressureCurve: tablet.pressureCurve,
    });
    if (switched) {
      setTabletBackend(toggleTargetBackend);
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let rafId: number | null = null;
    let pending: PointerEventDiagnosticsSnapshot | null = null;

    const flush = () => {
      rafId = null;
      if (pending) {
        setPointerDiag(pending);
        pending = null;
      }
    };

    const scheduleFlush = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(flush);
    };

    const onPointer = (event: Event) => {
      const pe = event as PointerEvent & {
        twist?: number;
        altitudeAngle?: number;
        azimuthAngle?: number;
      };
      if (pe.pointerType !== 'pen') return;

      const rawTiltX = Number.isFinite(pe.tiltX) ? pe.tiltX : 0;
      const rawTiltY = Number.isFinite(pe.tiltY) ? pe.tiltY : 0;
      const rawTwist = Number.isFinite(pe.twist) ? pe.twist! : 0;
      const normalizedTwist = ((rawTwist % 360) + 360) % 360;

      pending = {
        eventType: pe.type,
        pointerId: Number.isFinite(pe.pointerId) ? pe.pointerId : 0,
        pressure: Number.isFinite(pe.pressure) ? pe.pressure : 0,
        tiltX: rawTiltX,
        tiltY: rawTiltY,
        normalizedTiltX: normalizeTiltDegrees(rawTiltX),
        normalizedTiltY: normalizeTiltDegrees(rawTiltY),
        twist: normalizedTwist,
        altitudeAngleRad: Number.isFinite(pe.altitudeAngle) ? pe.altitudeAngle! : null,
        azimuthAngleRad: Number.isFinite(pe.azimuthAngle) ? pe.azimuthAngle! : null,
        buttons: Number.isFinite(pe.buttons) ? pe.buttons : 0,
        isPrimary: Boolean(pe.isPrimary),
        timeStamp: Number.isFinite(pe.timeStamp) ? pe.timeStamp : 0,
      };
      scheduleFlush();
    };

    const options: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener('pointerdown', onPointer, options);
    window.addEventListener('pointermove', onPointer, options);
    window.addEventListener('pointerup', onPointer, options);
    window.addEventListener('pointercancel', onPointer, options);
    window.addEventListener('pointerrawupdate', onPointer, options);

    return () => {
      window.removeEventListener('pointerdown', onPointer, options);
      window.removeEventListener('pointermove', onPointer, options);
      window.removeEventListener('pointerup', onPointer, options);
      window.removeEventListener('pointercancel', onPointer, options);
      window.removeEventListener('pointerrawupdate', onPointer, options);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  const pointerRawUpdateSupported = typeof window !== 'undefined' && 'onpointerrawupdate' in window;

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

      <div className="settings-section">
        <label className="settings-label">POINTEREVENT LIVE</label>
        <div className="tablet-live-card">
          {pointerDiag ? (
            <>
              <div className="status-row">
                <span>Last Event:</span>
                <span>{pointerDiag.eventType}</span>
              </div>
              <div className="status-row">
                <span>Pointer ID:</span>
                <span>{pointerDiag.pointerId}</span>
              </div>
              <div className="status-row">
                <span>Pressure:</span>
                <span>{toFixed(pointerDiag.pressure, 4)}</span>
              </div>
              <div className="status-row">
                <span>Tilt X / Y (raw deg):</span>
                <span>
                  {toFixed(pointerDiag.tiltX, 1)} / {toFixed(pointerDiag.tiltY, 1)}
                </span>
              </div>
              <div className="status-row">
                <span>Tilt X / Y (normalized):</span>
                <span>
                  {toFixed(pointerDiag.normalizedTiltX, 4)} /{' '}
                  {toFixed(pointerDiag.normalizedTiltY, 4)}
                </span>
              </div>
              <div className="status-row">
                <span>Twist / Rotation:</span>
                <span>{toFixed(pointerDiag.twist, 1)}°</span>
              </div>
              <div className="status-row">
                <span>Altitude / Azimuth:</span>
                <span>
                  {toFixed(pointerDiag.altitudeAngleRad ?? Number.NaN, 4)} rad (
                  {toDegreesString(pointerDiag.altitudeAngleRad)}°) /{' '}
                  {toFixed(pointerDiag.azimuthAngleRad ?? Number.NaN, 4)} rad (
                  {toDegreesString(pointerDiag.azimuthAngleRad)}°)
                </span>
              </div>
              <div className="status-row">
                <span>Buttons / Primary:</span>
                <span>
                  {pointerDiag.buttons} / {pointerDiag.isPrimary ? 'true' : 'false'}
                </span>
              </div>
              <div className="status-row">
                <span>Event Timestamp:</span>
                <span>{toFixed(pointerDiag.timeStamp, 1)} ms</span>
              </div>
            </>
          ) : (
            <div className="tablet-live-empty">
              未收到 pen PointerEvent。把笔移到应用窗口内并悬停/落笔后，这里会实时刷新。
            </div>
          )}
          <div className="tablet-live-hint">
            监听源：window PointerEvent（仅 pointerType=pen） | pointerrawupdate 支持：
            {pointerRawUpdateSupported ? 'Yes' : 'No'}
          </div>
        </div>
      </div>

      {/* Pressure Curve - always visible */}
      <div className="settings-section">
        <label className="settings-label">PRESSURE CURVE</label>
        <div className="settings-row">
          <span>Curve:</span>
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
      </div>

      <div className="settings-section">
        <label className="settings-label">WINDOWS INK TIPS</label>
        <div className="tablet-hint-card">
          <p className="tablet-hint-title">For PointerEvent pressure stability on Windows</p>
          <p className="tablet-hint-text">
            Open <code>{WINDOWS_INK_SETTINGS_PATH}</code>, then under Additional pen settings turn
            these off:
          </p>
          <ul className="tablet-hint-list">
            {WINDOWS_INK_DISABLE_OPTIONS.map((option) => (
              <li key={option}>{option}</li>
            ))}
          </ul>
          <p className="tablet-hint-text">
            In Wacom Tablet Properties, keep <code>Use Windows Ink</code> enabled when using the
            PointerEvent backend.
          </p>
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
              <button className="settings-btn" onClick={handleToggleBackend}>
                {toggleBackendLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Brush settings tab (Renderer settings)
const RENDER_MODES: { id: RenderMode; label: string; description: string }[] = [
  { id: 'gpu', label: 'GPU', description: 'WebGPU accelerated' },
  { id: 'cpu', label: 'CPU', description: 'Canvas 2D fallback' },
];

const GPU_RENDER_SCALE_MODES: { id: GPURenderScaleMode; label: string; description: string }[] = [
  { id: 'off', label: 'Off', description: 'Always render at full resolution' },
  {
    id: 'auto',
    label: 'Auto',
    description: 'Downsample for soft large brushes (hardness < 70, size > 300)',
  },
];

function BrushSettings() {
  const brush = useSettingsStore((s) => s.brush);
  const setRenderMode = useSettingsStore((s) => s.setRenderMode);
  const setGpuRenderScaleMode = useSettingsStore((s) => s.setGpuRenderScaleMode);

  return (
    <div className="settings-content">
      <h3 className="settings-section-title">Brush</h3>

      {/* Renderer Settings */}
      <div className="settings-section">
        <label className="settings-label">RENDERER</label>

        <div className="settings-row">
          <span>Mode:</span>
          <select
            className="settings-select"
            value={brush.renderMode}
            onChange={(e) => setRenderMode(e.target.value as RenderMode)}
            title={RENDER_MODES.find((m) => m.id === brush.renderMode)?.description}
          >
            {RENDER_MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
        </div>

        {brush.renderMode === 'gpu' && (
          <>
            <div className="settings-row">
              <span>Downsample:</span>
              <select
                className="settings-select"
                value={brush.gpuRenderScaleMode}
                onChange={(e) => setGpuRenderScaleMode(e.target.value as GPURenderScaleMode)}
                title={
                  GPU_RENDER_SCALE_MODES.find((m) => m.id === brush.gpuRenderScaleMode)?.description
                }
              >
                {GPU_RENDER_SCALE_MODES.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
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
      case 'general':
        return <GeneralSettings />;
      case 'brush':
        return <BrushSettings />;
      case 'tablet':
        return <TabletSettings />;
      default:
        return <AppearanceSettings />;
    }
  };

  return (
    <div className="settings-overlay">
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

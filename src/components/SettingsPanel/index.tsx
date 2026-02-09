import { useCallback, useEffect, useRef, useState } from 'react';
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
const POINTER_DIAG_UPDATE_INTERVAL_MS = 66;
const FALLBACK_SCROLLBAR_HIT_WIDTH = 18;
const FALLBACK_SCROLLBAR_HIT_HEIGHT = 18;
const SETTINGS_SCROLL_DRAG_BLOCK_SELECTOR =
  'button, input, textarea, select, option, a, [role="button"], .toggle-switch, .settings-select, .settings-number-input';

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

interface SettingsScrollDragState {
  mode: 'content' | 'scrollbar';
  container: HTMLDivElement;
  pointerId: number;
  startY: number;
  startScrollTop: number;
  scrollScaleY: number;
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

function parsePixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isPointerOnElementScrollbar(
  element: HTMLElement,
  clientX: number,
  clientY: number
): boolean {
  const rect = element.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return false;
  }

  const hasVerticalOverflow = element.scrollHeight > element.clientHeight;
  const hasHorizontalOverflow = element.scrollWidth > element.clientWidth;
  if (!hasVerticalOverflow && !hasHorizontalOverflow) return false;

  const style = window.getComputedStyle(element);
  const borderLeft = parsePixels(style.borderLeftWidth);
  const borderRight = parsePixels(style.borderRightWidth);
  const borderTop = parsePixels(style.borderTopWidth);
  const borderBottom = parsePixels(style.borderBottomWidth);

  const scrollbarWidth = Math.max(
    0,
    element.offsetWidth - element.clientWidth - borderLeft - borderRight
  );
  const verticalScrollbarHitWidth =
    hasVerticalOverflow && scrollbarWidth <= 0 ? FALLBACK_SCROLLBAR_HIT_WIDTH : scrollbarWidth;
  if (hasVerticalOverflow && verticalScrollbarHitWidth > 0) {
    const scrollbarLeft = rect.right - borderRight - verticalScrollbarHitWidth;
    const scrollbarRight = rect.right - borderRight;
    if (clientX >= scrollbarLeft && clientX <= scrollbarRight) {
      return true;
    }
  }

  const scrollbarHeight = Math.max(
    0,
    element.offsetHeight - element.clientHeight - borderTop - borderBottom
  );
  const horizontalScrollbarHitHeight =
    hasHorizontalOverflow && scrollbarHeight <= 0 ? FALLBACK_SCROLLBAR_HIT_HEIGHT : scrollbarHeight;
  if (hasHorizontalOverflow && horizontalScrollbarHitHeight > 0) {
    const scrollbarTop = rect.bottom - borderBottom - horizontalScrollbarHitHeight;
    const scrollbarBottom = rect.bottom - borderBottom;
    if (clientY >= scrollbarTop && clientY <= scrollbarBottom) {
      return true;
    }
  }

  return false;
}

function isSettingsScrollDragBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(SETTINGS_SCROLL_DRAG_BLOCK_SELECTOR);
}

function getVerticalScrollDragScale(element: HTMLElement): number {
  const scrollRange = element.scrollHeight - element.clientHeight;
  if (scrollRange <= 0) return 1;

  const trackSize = element.clientHeight;
  if (trackSize <= 0) return 1;

  // 近似 thumb 大小，足够用于将手势位移映射到 scrollTop。
  const estimatedThumbSize = Math.max(24, (trackSize * trackSize) / element.scrollHeight);
  const thumbTravelRange = Math.max(1, trackSize - estimatedThumbSize);
  return scrollRange / thumbTravelRange;
}

function releasePointerCaptureSafely(container: HTMLDivElement, pointerId: number): void {
  try {
    container.releasePointerCapture(pointerId);
  } catch {
    // 释放失败时忽略。
  }
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

    let timeoutId: number | null = null;
    let pending: PointerEventDiagnosticsSnapshot | null = null;

    const flush = () => {
      timeoutId = null;
      if (pending) {
        setPointerDiag(pending);
        pending = null;
      }
    };

    const scheduleFlush = () => {
      if (timeoutId !== null) return;
      timeoutId = window.setTimeout(flush, POINTER_DIAG_UPDATE_INTERVAL_MS);
    };

    const onPointer = (event: Event) => {
      const pe = event as PointerEvent & {
        twist?: number;
        altitudeAngle?: number;
        azimuthAngle?: number;
      };
      if (pe.pointerType !== 'pen') return;

      const isHighFrequencyPointerEvent =
        pe.type === 'pointermove' || pe.type === 'pointerrawupdate';
      if (isHighFrequencyPointerEvent && pe.buttons !== 0) {
        const eventTarget = pe.target instanceof Element ? pe.target : null;
        const elementAtPoint =
          Number.isFinite(pe.clientX) && Number.isFinite(pe.clientY)
            ? document.elementFromPoint(pe.clientX, pe.clientY)
            : null;
        const hitElement = eventTarget ?? elementAtPoint;
        if (hitElement?.closest('.settings-main')) {
          return;
        }
      }

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
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  const pointerRawUpdateSupported = typeof window !== 'undefined' && 'onpointerrawupdate' in window;

  return (
    <div className="settings-content">
      <h3 className="settings-section-title">Tablet</h3>

      {isInitialized && (
        <div className="settings-section">
          <label className="settings-label">BACKEND SWITCH</label>
          <div className="settings-actions">
            <button className="settings-btn" onClick={handleToggleBackend}>
              {toggleBackendLabel}
            </button>
          </div>
        </div>
      )}

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
  const scrollDragRef = useRef<SettingsScrollDragState | null>(null);

  const clearScrollDragSession = useCallback((pointerId?: number): boolean => {
    const drag = scrollDragRef.current;
    if (!drag) return false;
    if (typeof pointerId === 'number' && drag.pointerId !== pointerId) return false;
    releasePointerCaptureSafely(drag.container, drag.pointerId);
    scrollDragRef.current = null;
    return true;
  }, []);

  useEffect(() => {
    if (!isOpen) {
      clearScrollDragSession();
      return;
    }

    const handleWindowPointerMove = (event: PointerEvent): void => {
      const drag = scrollDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.mode !== 'scrollbar') return;
      const deltaY = event.clientY - drag.startY;
      drag.container.scrollTop = drag.startScrollTop + deltaY * drag.scrollScaleY;
      event.preventDefault();
    };

    const handleWindowPointerUp = (event: PointerEvent): void => {
      clearScrollDragSession(event.pointerId);
    };

    const handleWindowPointerCancel = (event: PointerEvent): void => {
      clearScrollDragSession(event.pointerId);
    };

    const handleWindowBlur = (): void => {
      clearScrollDragSession();
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { capture: true });
    window.addEventListener('pointerup', handleWindowPointerUp, { capture: true });
    window.addEventListener('pointercancel', handleWindowPointerCancel, { capture: true });
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove, { capture: true });
      window.removeEventListener('pointerup', handleWindowPointerUp, { capture: true });
      window.removeEventListener('pointercancel', handleWindowPointerCancel, { capture: true });
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [isOpen, clearScrollDragSession]);

  if (!isOpen) return null;

  const handleSettingsMainPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const currentDrag = scrollDragRef.current;
    if (currentDrag && currentDrag.pointerId !== event.pointerId) {
      clearScrollDragSession();
    }

    if (event.button !== 0) return;
    if (isSettingsScrollDragBlockedTarget(event.target)) {
      clearScrollDragSession(event.pointerId);
      return;
    }
    const onScrollbar = isPointerOnElementScrollbar(
      event.currentTarget,
      event.clientX,
      event.clientY
    );
    // 某些平台在滚动条上会把 pen 事件上报为 mouse；滚动条模式不做 pointerType 限制。
    if (!onScrollbar && event.pointerType !== 'pen' && event.pointerType !== 'touch') return;

    event.preventDefault();
    event.stopPropagation();

    scrollDragRef.current = {
      mode: onScrollbar ? 'scrollbar' : 'content',
      container: event.currentTarget,
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: event.currentTarget.scrollTop,
      scrollScaleY: onScrollbar ? getVerticalScrollDragScale(event.currentTarget) : 1,
    };

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败时忽略，避免打断滚动。
    }
  };

  const handleSettingsMainPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = scrollDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.mode === 'scrollbar') {
      // 在某些 pen 实现中，离开滚动条后 buttons 可能瞬时变为 0。
      // 这里不依赖 buttons，直到 pointerup/pointercancel 再结束拖拽。
      event.preventDefault();
      const deltaY = event.clientY - drag.startY;
      event.currentTarget.scrollTop = drag.startScrollTop + deltaY * drag.scrollScaleY;
      return;
    }

    if (isPointerOnElementScrollbar(event.currentTarget, event.clientX, event.clientY)) {
      clearScrollDragSession(event.pointerId);
      return;
    }
    if ((event.buttons & 1) === 0) {
      clearScrollDragSession(event.pointerId);
      return;
    }

    event.preventDefault();
    const deltaY = event.clientY - drag.startY;
    event.currentTarget.scrollTop = drag.startScrollTop - deltaY;
  };

  const finishSettingsMainPointerDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    clearScrollDragSession(event.pointerId);
  };

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
          <div
            className="settings-main"
            onPointerDown={handleSettingsMainPointerDown}
            onPointerMove={handleSettingsMainPointerMove}
            onPointerUp={finishSettingsMainPointerDrag}
            onPointerCancel={finishSettingsMainPointerDrag}
          >
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  );
}

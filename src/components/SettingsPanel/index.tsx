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
import { useI18n } from '@/i18n';
import { useI18nStore } from '@/stores/i18n';
import { useTabletStore, BackendType, InputBackpressureMode, TabletStatus } from '@/stores/tablet';
import { detectPlatformKind } from '@/utils/platform';
import { PressureCurveEditor } from './PressureCurveEditor';
import { getPressureCurvePresetPoints } from '@/utils/pressureCurve';
import './SettingsPanel.css';

// Tab configuration
interface TabConfig {
  id: string;
  labelKey: string;
  icon: React.ReactNode;
}

interface SettingsSidebarProps {
  tabs: TabConfig[];
  activeTabId: string;
  onTabSelect: (id: string) => void;
}

interface ColorSwatchProps {
  color: string;
  isSelected: boolean;
  onClick: () => void;
}

const TABS: TabConfig[] = [
  { id: 'appearance', labelKey: 'settings.tab.appearance', icon: <Palette size={16} /> },
  { id: 'general', labelKey: 'settings.tab.general', icon: <Settings2 size={16} /> },
  { id: 'brush', labelKey: 'settings.tab.brush', icon: <Brush size={16} /> },
  { id: 'tablet', labelKey: 'settings.tab.tablet', icon: <Tablet size={16} /> },
];
const POINTER_DIAG_UPDATE_INTERVAL_MS = 66;
const FALLBACK_SCROLLBAR_HIT_WIDTH = 18;
const FALLBACK_SCROLLBAR_HIT_HEIGHT = 18;
const SETTINGS_SCROLL_DRAG_BLOCK_SELECTOR =
  'button, input, textarea, select, option, a, [role="button"], .toggle-switch, .settings-select, .settings-number-input';

function getTabletStatusColor(status: TabletStatus): string {
  if (status === 'Connected') return '#4f4';
  if (status === 'Error') return '#f44';
  return '#888';
}

function getTabletStatusLabel(status: TabletStatus, t: (key: string) => string): string {
  if (status === 'Connected') return t('settings.tablet.status.value.connected');
  if (status === 'Error') return t('settings.tablet.status.value.error');
  return t('settings.tablet.status.value.disconnected');
}

function getBackpressureModeLabel(mode: InputBackpressureMode, t: (key: string) => string): string {
  if (mode === 'latency_capped') {
    return t('settings.tablet.inputPipeline.latencyCapped');
  }
  return t('settings.tablet.inputPipeline.lossless');
}

function getPollingRateLabel(
  rate: number,
  t: (key: string, params?: Record<string, number>) => string
): string {
  return t('settings.tablet.configuration.pollingRateHz', { rate });
}

function normalizeBackendType(
  value: string | null | undefined,
  preferredBackend: BackendType
): BackendType {
  if (value === 'wintab') return 'wintab';
  if (value === 'macnative') return 'macnative';
  if (value === 'pointerevent') return 'pointerevent';
  return preferredBackend;
}

interface PointerEventDiagnosticsSnapshot {
  eventType: string;
  pointerType: string;
  pointerId: number;
  pressure: number;
  webkitForce: number | null;
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

function normalizeRotationDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}

function toFixed(value: number, digits: number = 3): string {
  if (!Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

function formatLatencyUs(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '-';
  return `${(value / 1000).toFixed(2)} ms`;
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

  // Approximate thumb size to map pointer travel to scrollTop.
  const estimatedThumbSize = Math.max(24, (trackSize * trackSize) / element.scrollHeight);
  const thumbTravelRange = Math.max(1, trackSize - estimatedThumbSize);
  return scrollRange / thumbTravelRange;
}

function releasePointerCaptureSafely(container: HTMLDivElement, pointerId: number): void {
  try {
    container.releasePointerCapture(pointerId);
  } catch {
    // Ignore invalid release attempts on edge cases.
  }
}

// Sidebar component
function SettingsSidebar({ tabs, activeTabId, onTabSelect }: SettingsSidebarProps) {
  const { t } = useI18n();
  return (
    <div className="settings-sidebar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`settings-sidebar-item ${activeTabId === tab.id ? 'active' : ''}`}
          onClick={() => onTabSelect(tab.id)}
        >
          {tab.icon}
          <span>{t(tab.labelKey)}</span>
        </button>
      ))}
    </div>
  );
}

// Color swatch component
function ColorSwatch({ color, isSelected, onClick }: ColorSwatchProps) {
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
  const { t } = useI18n();

  return (
    <div className="settings-content">
      <h3 className="settings-section-title">{t('settings.tab.appearance')}</h3>

      {/* Accent Color */}
      <div className="settings-section">
        <label className="settings-label">{t('settings.appearance.accentColor')}</label>
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
        <label className="settings-label">{t('settings.appearance.panelBackground')}</label>
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
        <label className="settings-label">{t('settings.appearance.canvasBackground')}</label>
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
        <label className="settings-label">{t('settings.appearance.blurEffect')}</label>
        <div className="settings-row">
          <span className="settings-description">{t('settings.appearance.blurEffectDesc')}</span>
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
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const setAutosaveIntervalMinutes = useSettingsStore((s) => s.setAutosaveIntervalMinutes);
  const setOpenLastFileOnStartup = useSettingsStore((s) => s.setOpenLastFileOnStartup);
  const setLocale = useI18nStore((s) => s.setLocale);
  const { t, availableLocales } = useI18n();
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
      <h3 className="settings-section-title">{t('settings.tab.general')}</h3>

      <div className="settings-section">
        <label className="settings-label">{t('settings.general.language')}</label>
        <div className="settings-row">
          <span className="settings-description">{t('settings.general.languageDesc')}</span>
          <select
            className="settings-select"
            value={general.language}
            onChange={(e) => {
              const resolved = setLocale(e.target.value);
              setLanguage(resolved);
            }}
            aria-label={t('settings.general.language')}
          >
            {availableLocales.map((locale) => (
              <option key={locale.code} value={locale.code}>
                {locale.displayName} ({locale.nativeName})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">{t('settings.general.autoSave')}</label>
        <div className="settings-row">
          <span className="settings-description">{t('settings.general.autoSaveDesc')}</span>
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
        <label className="settings-label">{t('settings.general.startup')}</label>
        <div className="settings-row">
          <span className="settings-description">
            {t('settings.general.openLastFileOnStartup')}
          </span>
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
  const { t } = useI18n();
  const {
    tablet,
    setTabletBackend,
    setPollingRate,
    setAutoStart,
    setPressureCurve,
    setPressureCurvePoints,
    setLowPressureAdaptiveSmoothingEnabled,
    setBackpressureMode,
  } = useSettingsStore();

  const {
    status,
    backend,
    requestedBackend,
    activeBackend,
    backpressureMode,
    queueMetrics,
    info,
    isInitialized,
    isStreaming,
    currentPoint,
    inProximity,
    init,
    switchBackend,
    start,
    stop,
    refresh,
  } = useTabletStore();

  const statusColor = getTabletStatusColor(status);
  const statusLabel = getTabletStatusLabel(status, t);
  const backpressureModeLabel = getBackpressureModeLabel(backpressureMode, t);
  const [pointerDiag, setPointerDiag] = useState<PointerEventDiagnosticsSnapshot | null>(null);
  const [isApplyingPipelineConfig, setIsApplyingPipelineConfig] = useState(false);
  const platformKind = detectPlatformKind();
  const preferredNativeBackend: BackendType =
    platformKind === 'macos' ? 'macnative' : platformKind === 'windows' ? 'wintab' : 'pointerevent';
  const showBackendToggle = platformKind === 'windows' || platformKind === 'macos';
  const activeBackendLower =
    typeof activeBackend === 'string' ? activeBackend.toLowerCase() : 'none';
  const requestedBackendType = normalizeBackendType(
    requestedBackend || tablet.backend,
    preferredNativeBackend
  );
  const isNativeBackendActive =
    activeBackendLower === 'wintab' || activeBackendLower === 'macnative';
  const toggleTargetBackend: BackendType = isNativeBackendActive
    ? 'pointerevent'
    : preferredNativeBackend;
  const toggleBackendLabel = isNativeBackendActive
    ? t('settings.tablet.backendSwitch.usePointerEvent')
    : platformKind === 'macos'
      ? t('settings.tablet.backendSwitch.useMacNative')
      : platformKind === 'windows'
        ? t('settings.tablet.backendSwitch.useWinTab')
        : t('settings.tablet.backendSwitch.usePointerEvent');
  const backendSwitchOptions = {
    pollingRate: tablet.pollingRate,
    pressureCurve: tablet.pressureCurve,
    backpressureMode: tablet.backpressureMode,
  };

  const handleResetPressureCurve = (): void => {
    const preset = 'linear';
    setPressureCurve(preset);
    setPressureCurvePoints(getPressureCurvePresetPoints(preset));
  };

  const handleInit = async () => {
    await init({
      backend: tablet.backend,
      ...backendSwitchOptions,
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
    const switched = await switchBackend(toggleTargetBackend, backendSwitchOptions);
    if (switched) {
      setTabletBackend(toggleTargetBackend);
    }
  };

  const handleApplyPipelineConfig = async () => {
    if (!isInitialized) return;
    setIsApplyingPipelineConfig(true);
    try {
      const switched = await switchBackend(requestedBackendType, backendSwitchOptions);
      if (switched) {
        setTabletBackend(requestedBackendType);
      }
      await refresh();
    } finally {
      setIsApplyingPipelineConfig(false);
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
        webkitForce?: number;
      };

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
        pointerType: typeof pe.pointerType === 'string' ? pe.pointerType : 'unknown',
        pointerId: Number.isFinite(pe.pointerId) ? pe.pointerId : 0,
        pressure: Number.isFinite(pe.pressure) ? pe.pressure : 0,
        webkitForce: Number.isFinite(pe.webkitForce) ? pe.webkitForce! : null,
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
  const liveInputSourceHint = isNativeBackendActive
    ? activeBackendLower === 'macnative'
      ? t('settings.tablet.liveInput.macnative')
      : t('settings.tablet.liveInput.wintab')
    : t('settings.tablet.liveInput.pointerEvent', {
        support: pointerRawUpdateSupported ? t('common.yes') : t('common.no'),
      });
  const pointerEventLooksMouseOnly =
    !isNativeBackendActive &&
    pointerDiag !== null &&
    pointerDiag.pointerType === 'mouse' &&
    pointerDiag.pressure <= 0 &&
    (pointerDiag.webkitForce === null || pointerDiag.webkitForce <= 0);

  return (
    <div className="settings-content">
      <h3 className="settings-section-title">{t('settings.tab.tablet')}</h3>

      {isInitialized && showBackendToggle && (
        <div className="settings-section">
          <label className="settings-label">{t('settings.tablet.backendSwitch.title')}</label>
          <div className="settings-actions">
            <button className="settings-btn" onClick={handleToggleBackend}>
              {toggleBackendLabel}
            </button>
          </div>
        </div>
      )}

      <div className="settings-section">
        <label className="settings-label">{t('settings.tablet.pressureCurve.title')}</label>
        <div className="pressure-curve-section">
          <PressureCurveEditor
            points={tablet.pressureCurvePoints}
            onChange={setPressureCurvePoints}
          />
          <div className="pressure-curve-labels">
            <span>{t('settings.tablet.pressureCurve.lowPressure')}</span>
            <span>{t('settings.tablet.pressureCurve.highPressure')}</span>
          </div>
          <div className="pressure-curve-preset-row">
            <span>{t('settings.tablet.pressureCurve.preset')}</span>
            <div className="settings-actions">
              <button className="settings-btn" onClick={handleResetPressureCurve}>
                {t('settings.tablet.pressureCurve.reset')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Speed controls are hidden while pressure-tail parity mode is active. */}

      <div className="settings-section">
        <label className="settings-label">{t('settings.tablet.dynamics.title')}</label>
        <div className="settings-row">
          <span className="settings-description">
            {t('settings.tablet.dynamics.lowPressureAdaptiveSmoothing')}
          </span>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={tablet.lowPressureAdaptiveSmoothingEnabled}
              onChange={(e) => setLowPressureAdaptiveSmoothingEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      {/* Status */}
      <div className="settings-section">
        <label className="settings-label">{t('settings.tablet.status.title')}</label>
        <div className="tablet-status-info">
          <div className="status-row">
            <span>{t('settings.tablet.status.status')}</span>
            <span style={{ color: statusColor }}>{statusLabel}</span>
          </div>
          <div className="status-row">
            <span>{t('settings.tablet.status.requestedBackend')}</span>
            <span>{requestedBackend}</span>
          </div>
          <div className="status-row">
            <span>{t('settings.tablet.status.activeBackend')}</span>
            <span>{activeBackend}</span>
          </div>
          <div className="status-row">
            <span>{t('settings.tablet.status.backpressure')}</span>
            <span>{backpressureModeLabel}</span>
          </div>
          {info && (
            <>
              <div className="status-row">
                <span>{t('settings.tablet.status.device')}</span>
                <span>{info.name}</span>
              </div>
              <div className="status-row">
                <span>{t('settings.tablet.status.backend')}</span>
                <span>{backend}</span>
              </div>
              <div className="status-row">
                <span>{t('settings.tablet.status.pressureRange')}</span>
                <span>
                  {info.pressure_range[0]} - {info.pressure_range[1]}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">{t('settings.tablet.inputPipeline.title')}</label>
        <div className="settings-row">
          <span>{t('settings.tablet.inputPipeline.backpressureMode')}</span>
          <select
            className="settings-select"
            value={tablet.backpressureMode}
            onChange={(e) => setBackpressureMode(e.target.value as InputBackpressureMode)}
          >
            <option value="lossless">{t('settings.tablet.inputPipeline.lossless')}</option>
            <option value="latency_capped">
              {t('settings.tablet.inputPipeline.latencyCapped')}
            </option>
          </select>
        </div>
        <div className="settings-row">
          <span>{t('settings.tablet.inputPipeline.queueEnqueuedDequeued')}</span>
          <span>
            {queueMetrics.enqueued} / {queueMetrics.dequeued}
          </span>
        </div>
        <div className="settings-row">
          <span>{t('settings.tablet.inputPipeline.queueDropped')}</span>
          <span>{queueMetrics.dropped}</span>
        </div>
        <div className="settings-row">
          <span>{t('settings.tablet.inputPipeline.queueDepth')}</span>
          <span>
            {queueMetrics.current_depth} / {queueMetrics.max_depth}
          </span>
        </div>
        <div className="settings-row">
          <span>{t('settings.tablet.inputPipeline.queueLatencyPercentiles')}</span>
          <span>
            {formatLatencyUs(queueMetrics.latency_p50_us)} /{' '}
            {formatLatencyUs(queueMetrics.latency_p95_us)} /{' '}
            {formatLatencyUs(queueMetrics.latency_p99_us)}
          </span>
        </div>
        <div className="settings-row">
          <span>{t('settings.tablet.inputPipeline.queueLatencyLast')}</span>
          <span>{formatLatencyUs(queueMetrics.latency_last_us)}</span>
        </div>
        {isInitialized && (
          <>
            <div className="settings-actions">
              <button
                className="settings-btn"
                disabled={isApplyingPipelineConfig}
                onClick={handleApplyPipelineConfig}
              >
                {isApplyingPipelineConfig
                  ? t('settings.tablet.inputPipeline.applying')
                  : t('settings.tablet.inputPipeline.applyConfig')}
              </button>
            </div>
            <div className="tablet-live-hint">{t('settings.tablet.inputPipeline.applyHint')}</div>
          </>
        )}
      </div>

      <div className="settings-section">
        <label className="settings-label">
          {isNativeBackendActive
            ? activeBackendLower === 'macnative'
              ? t('settings.tablet.live.macnativeTitle')
              : t('settings.tablet.live.wintabTitle')
            : t('settings.tablet.live.pointerEventTitle')}
        </label>
        <div className="tablet-live-card">
          {isNativeBackendActive ? (
            currentPoint ? (
              <>
                <div className="status-row">
                  <span>{t('settings.tablet.live.inProximity')}</span>
                  <span>{inProximity ? t('common.true') : t('common.false')}</span>
                </div>
                <div className="status-row">
                  <span>{t('settings.tablet.live.sampleSeqStream')}</span>
                  <span>
                    {currentPoint.seq} / {currentPoint.stroke_id}
                  </span>
                </div>
                <div className="status-row">
                  <span>{t('settings.tablet.live.phase')}</span>
                  <span>{currentPoint.phase}</span>
                </div>
                <div className="status-row">
                  <span>{t('settings.tablet.live.pressure')}</span>
                  <span>{toFixed(currentPoint.pressure, 4)}</span>
                </div>
                <div className="status-row">
                  <span>{t('settings.tablet.live.tiltRaw')}</span>
                  <span>
                    {toFixed(currentPoint.tilt_x, 1)} / {toFixed(currentPoint.tilt_y, 1)}
                  </span>
                </div>
                <div className="status-row">
                  <span>{t('settings.tablet.live.tiltNormalized')}</span>
                  <span>
                    {toFixed(normalizeTiltDegrees(currentPoint.tilt_x), 4)} /{' '}
                    {toFixed(normalizeTiltDegrees(currentPoint.tilt_y), 4)}
                  </span>
                </div>
                <div className="status-row">
                  <span>{t('settings.tablet.live.rotation')}</span>
                  <span>{toFixed(normalizeRotationDegrees(currentPoint.rotation), 1)}°</span>
                </div>
                <div className="status-row">
                  <span>{t('settings.tablet.live.sourcePointerId')}</span>
                  <span>
                    {currentPoint.source} / {currentPoint.pointer_id}
                  </span>
                </div>
                <div className="status-row">
                  <span>{t('settings.tablet.live.hostDeviceTime')}</span>
                  <span>
                    {toFixed(currentPoint.host_time_us / 1000, 3)} ms /{' '}
                    {toFixed((currentPoint.device_time_us ?? currentPoint.host_time_us) / 1000, 3)}{' '}
                    ms
                  </span>
                </div>
              </>
            ) : (
              <div className="tablet-live-empty">{t('settings.tablet.live.noNativeSample')}</div>
            )
          ) : pointerDiag ? (
            <>
              <div className="status-row">
                <span>{t('settings.tablet.live.lastEvent')}</span>
                <span>{pointerDiag.eventType}</span>
              </div>
              <div className="status-row">
                <span>{t('settings.tablet.live.pointerType')}</span>
                <span>{pointerDiag.pointerType}</span>
              </div>
              <div className="status-row">
                <span>{t('settings.tablet.live.pointerId')}</span>
                <span>{pointerDiag.pointerId}</span>
              </div>
              <div className="status-row">
                <span>{t('settings.tablet.live.pressure')}</span>
                <span>{toFixed(pointerDiag.pressure, 4)}</span>
              </div>
              <div className="status-row">
                <span>{t('settings.tablet.live.webkitForce')}</span>
                <span>{toFixed(pointerDiag.webkitForce ?? Number.NaN, 4)}</span>
              </div>
              <div className="status-row">
                <span>{t('settings.tablet.live.tiltRaw')}</span>
                <span>
                  {toFixed(pointerDiag.tiltX, 1)} / {toFixed(pointerDiag.tiltY, 1)}
                </span>
              </div>
              <div className="status-row">
                <span>{t('settings.tablet.live.tiltNormalized')}</span>
                <span>
                  {toFixed(pointerDiag.normalizedTiltX, 4)} /{' '}
                  {toFixed(pointerDiag.normalizedTiltY, 4)}
                </span>
              </div>
              <div className="status-row">
                <span>{t('settings.tablet.live.twistRotation')}</span>
                <span>{toFixed(pointerDiag.twist, 1)}°</span>
              </div>
              <div className="status-row">
                <span>{t('settings.tablet.live.altitudeAzimuth')}</span>
                <span>
                  {toFixed(pointerDiag.altitudeAngleRad ?? Number.NaN, 4)} rad (
                  {toDegreesString(pointerDiag.altitudeAngleRad)}°) /{' '}
                  {toFixed(pointerDiag.azimuthAngleRad ?? Number.NaN, 4)} rad (
                  {toDegreesString(pointerDiag.azimuthAngleRad)}°)
                </span>
              </div>
              <div className="status-row">
                <span>{t('settings.tablet.live.buttonsPrimary')}</span>
                <span>
                  {pointerDiag.buttons} /{' '}
                  {pointerDiag.isPrimary ? t('common.true') : t('common.false')}
                </span>
              </div>
              <div className="status-row">
                <span>{t('settings.tablet.live.eventTimestamp')}</span>
                <span>{toFixed(pointerDiag.timeStamp, 1)} ms</span>
              </div>
              {pointerEventLooksMouseOnly && (
                <div className="status-row status-row-warning">
                  <span>{t('settings.tablet.live.warning')}</span>
                  <span>{t('settings.tablet.live.mouseOnlyWarning')}</span>
                </div>
              )}
            </>
          ) : (
            <div className="tablet-live-empty">{t('settings.tablet.live.noPointerEvent')}</div>
          )}
          <div className="tablet-live-hint">{liveInputSourceHint}</div>
        </div>
      </div>

      {/* Configuration (only before init) */}
      {!isInitialized && (
        <div className="settings-section">
          <label className="settings-label">{t('settings.tablet.configuration.title')}</label>

          <div className="settings-row">
            <span>{t('settings.tablet.configuration.backend')}</span>
            <select
              className="settings-select"
              value={tablet.backend}
              onChange={(e) => setTabletBackend(e.target.value as BackendType)}
            >
              {platformKind === 'windows' && (
                <option value="wintab">{t('settings.tablet.configuration.winTabOnly')}</option>
              )}
              {platformKind === 'macos' && (
                <option value="macnative">
                  {t('settings.tablet.configuration.macNativeOnly')}
                </option>
              )}
              <option value="pointerevent">
                {t('settings.tablet.configuration.pointerEventOnly')}
              </option>
            </select>
          </div>

          <div className="settings-row">
            <span>{t('settings.tablet.configuration.pollingRate')}</span>
            <select
              className="settings-select"
              value={tablet.pollingRate}
              onChange={(e) => setPollingRate(Number(e.target.value))}
            >
              <option value={100}>{getPollingRateLabel(100, t)}</option>
              <option value={200}>{getPollingRateLabel(200, t)}</option>
              <option value={500}>{getPollingRateLabel(500, t)}</option>
              <option value={1000}>{getPollingRateLabel(1000, t)}</option>
            </select>
          </div>

          <div className="settings-row">
            <span>{t('settings.tablet.configuration.autoStart')}</span>
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
        <label className="settings-label">{t('settings.tablet.actions.title')}</label>
        <div className="settings-actions">
          {!isInitialized ? (
            <button className="settings-btn primary" onClick={handleInit}>
              {t('settings.tablet.actions.initialize')}
            </button>
          ) : (
            <>
              <button
                className={`settings-btn ${isStreaming ? 'danger' : 'primary'}`}
                onClick={handleToggleStream}
              >
                {isStreaming
                  ? t('settings.tablet.actions.stop')
                  : t('settings.tablet.actions.start')}
              </button>
              <button className="settings-btn" onClick={refresh}>
                {t('settings.tablet.actions.refresh')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Brush settings tab (Renderer settings)
const RENDER_MODES: { id: RenderMode; labelKey: string; descriptionKey: string }[] = [
  {
    id: 'gpu',
    labelKey: 'settings.brush.renderer.mode.gpu.label',
    descriptionKey: 'settings.brush.renderer.mode.gpu.description',
  },
  {
    id: 'cpu',
    labelKey: 'settings.brush.renderer.mode.cpu.label',
    descriptionKey: 'settings.brush.renderer.mode.cpu.description',
  },
];

const GPU_RENDER_SCALE_MODES: {
  id: GPURenderScaleMode;
  labelKey: string;
  descriptionKey: string;
}[] = [
  {
    id: 'off',
    labelKey: 'settings.brush.renderer.downsample.off.label',
    descriptionKey: 'settings.brush.renderer.downsample.off.description',
  },
  {
    id: 'auto',
    labelKey: 'settings.brush.renderer.downsample.auto.label',
    descriptionKey: 'settings.brush.renderer.downsample.auto.description',
  },
];

function BrushSettings() {
  const brush = useSettingsStore((s) => s.brush);
  const setRenderMode = useSettingsStore((s) => s.setRenderMode);
  const setGpuRenderScaleMode = useSettingsStore((s) => s.setGpuRenderScaleMode);
  const setForceDomCursorDebug = useSettingsStore((s) => s.setForceDomCursorDebug);
  const setCursorLodPathLenLimit = useSettingsStore((s) => s.setCursorLodPathLenLimit);
  const resetCursorLodDebugDefaults = useSettingsStore((s) => s.resetCursorLodDebugDefaults);
  const { t } = useI18n();
  const { renderMode, gpuRenderScaleMode, forceDomCursorDebug, cursorLodDebug } = brush;
  const forceDomCursorDebugDescription = t('settings.brush.cursor.forceDomDebug.description');
  const [lod0Input, setLod0Input] = useState(String(cursorLodDebug.lod0PathLenSoftLimit));
  const [lod1Input, setLod1Input] = useState(String(cursorLodDebug.lod1PathLenLimit));
  const [lod2Input, setLod2Input] = useState(String(cursorLodDebug.lod2PathLenLimit));

  useEffect(() => {
    setLod0Input(String(cursorLodDebug.lod0PathLenSoftLimit));
    setLod1Input(String(cursorLodDebug.lod1PathLenLimit));
    setLod2Input(String(cursorLodDebug.lod2PathLenLimit));
  }, [
    cursorLodDebug.lod0PathLenSoftLimit,
    cursorLodDebug.lod1PathLenLimit,
    cursorLodDebug.lod2PathLenLimit,
  ]);

  const commitCursorLodLimit = (
    key: 'lod0PathLenSoftLimit' | 'lod1PathLenLimit' | 'lod2PathLenLimit',
    inputValue: string,
    setInput: (value: string) => void
  ) => {
    const parsed = Number.parseInt(inputValue, 10);
    if (!Number.isFinite(parsed)) {
      setInput(String(cursorLodDebug[key]));
      return;
    }
    setCursorLodPathLenLimit(key, parsed);
    const normalized = useSettingsStore.getState().brush.cursorLodDebug[key];
    setInput(String(normalized));
  };

  return (
    <div className="settings-content">
      <h3 className="settings-section-title">{t('settings.tab.brush')}</h3>

      {/* Renderer Settings */}
      <div className="settings-section">
        <label className="settings-label">{t('settings.brush.renderer.title')}</label>

        <div className="settings-row">
          <span>{t('settings.brush.renderer.mode')}</span>
          <select
            className="settings-select"
            value={renderMode}
            onChange={(e) => setRenderMode(e.target.value as RenderMode)}
            title={t(
              RENDER_MODES.find((m) => m.id === renderMode)?.descriptionKey ??
                'settings.brush.renderer.mode.gpu.description'
            )}
          >
            {RENDER_MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {t(mode.labelKey)}
              </option>
            ))}
          </select>
        </div>

        {renderMode === 'gpu' && (
          <>
            <div className="settings-row">
              <span>{t('settings.brush.renderer.downsample')}</span>
              <select
                className="settings-select"
                value={gpuRenderScaleMode}
                onChange={(e) => setGpuRenderScaleMode(e.target.value as GPURenderScaleMode)}
                title={t(
                  GPU_RENDER_SCALE_MODES.find((m) => m.id === gpuRenderScaleMode)?.descriptionKey ??
                    'settings.brush.renderer.downsample.off.description'
                )}
              >
                {GPU_RENDER_SCALE_MODES.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {t(mode.labelKey)}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        <div className="settings-row">
          <span title={forceDomCursorDebugDescription}>
            {t('settings.brush.cursor.forceDomDebug.label')}
          </span>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={forceDomCursorDebug}
              onChange={(e) => setForceDomCursorDebug(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">{t('settings.brush.cursor.lodDebug.title')}</label>
        <div className="settings-row">
          <span className="settings-description">
            {t('settings.brush.cursor.lodDebug.description')}
          </span>
        </div>
        <div className="settings-row">
          <span>{t('settings.brush.cursor.lodDebug.lod0PathLenSoftLimit')}</span>
          <input
            type="number"
            min={1}
            step={1}
            className="settings-number-input"
            value={lod0Input}
            onChange={(e) => setLod0Input(e.target.value)}
            onBlur={() => commitCursorLodLimit('lod0PathLenSoftLimit', lod0Input, setLod0Input)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitCursorLodLimit('lod0PathLenSoftLimit', lod0Input, setLod0Input);
              }
            }}
          />
        </div>
        <div className="settings-row">
          <span>{t('settings.brush.cursor.lodDebug.lod1PathLenLimit')}</span>
          <input
            type="number"
            min={1}
            step={1}
            className="settings-number-input"
            value={lod1Input}
            onChange={(e) => setLod1Input(e.target.value)}
            onBlur={() => commitCursorLodLimit('lod1PathLenLimit', lod1Input, setLod1Input)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitCursorLodLimit('lod1PathLenLimit', lod1Input, setLod1Input);
              }
            }}
          />
        </div>
        <div className="settings-row">
          <span>{t('settings.brush.cursor.lodDebug.lod2PathLenLimit')}</span>
          <input
            type="number"
            min={1}
            step={1}
            className="settings-number-input"
            value={lod2Input}
            onChange={(e) => setLod2Input(e.target.value)}
            onBlur={() => commitCursorLodLimit('lod2PathLenLimit', lod2Input, setLod2Input)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitCursorLodLimit('lod2PathLenLimit', lod2Input, setLod2Input);
              }
            }}
          />
        </div>
        <div className="settings-actions">
          <button className="settings-btn" onClick={resetCursorLodDebugDefaults}>
            {t('settings.brush.cursor.lodDebug.resetDefaults')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Main Settings Panel
export function SettingsPanel() {
  const { isOpen, activeTab, closeSettings, setActiveTab } = useSettingsStore();
  const { t } = useI18n();
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

    const handleWindowPointerRawUpdate = (event: Event): void => {
      handleWindowPointerMove(event as PointerEvent);
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { capture: true });
    window.addEventListener('pointerrawupdate', handleWindowPointerRawUpdate, { capture: true });
    window.addEventListener('pointerup', handleWindowPointerUp, { capture: true });
    window.addEventListener('pointercancel', handleWindowPointerCancel, { capture: true });
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove, { capture: true });
      window.removeEventListener('pointerrawupdate', handleWindowPointerRawUpdate, {
        capture: true,
      });
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
    // Some platforms report pen input as mouse on native scrollbars.
    // Keep scrollbar mode unrestricted by pointerType.
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
      // Ignore capture failures to avoid breaking scrolling.
    }
  };

  const handleSettingsMainPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = scrollDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.mode === 'scrollbar') {
      // Some pen implementations can temporarily report buttons=0 after leaving the scrollbar.
      // Keep the drag session alive until pointerup/pointercancel.
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

  const handleSettingsMainLostPointerCapture = (event: React.PointerEvent<HTMLDivElement>) => {
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
          <h2>{t('settings.title')}</h2>
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
            onLostPointerCapture={handleSettingsMainLostPointerCapture}
          >
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  );
}

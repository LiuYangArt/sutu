import { useEffect, useState } from 'react';
import { Tablet, Wifi, WifiOff, Settings, X } from 'lucide-react';
import { useTabletStore, BackendType } from '@/stores/tablet';
import './TabletPanel.css';

// Global toggle function for menu control
let toggleVisibilityFn: (() => void) | null = null;
let getVisibilityFn: (() => boolean) | null = null;

export const toggleTabletPanelVisibility = () => toggleVisibilityFn?.();
export const isTabletPanelVisible = () => getVisibilityFn?.() ?? false;

export function TabletPanel() {
  const [isVisible, setIsVisible] = useState(false); // Hidden by default
  const [isOpen, setIsOpen] = useState(false);

  // Register global toggle function
  useEffect(() => {
    toggleVisibilityFn = () => setIsVisible((v) => !v);
    getVisibilityFn = () => isVisible;
    return () => {
      toggleVisibilityFn = null;
      getVisibilityFn = null;
    };
  }, [isVisible]);
  const [selectedBackend, setSelectedBackend] = useState<BackendType>('auto');
  const [pollingRate, setPollingRate] = useState(200);
  const [pressureCurve, setPressureCurve] = useState('linear');

  const {
    status,
    backend,
    info,
    isInitialized,
    isStreaming,
    currentPoint,
    inProximity,
    init,
    start,
    stop,
    refresh,
    cleanup,
  } = useTabletStore();

  // Cleanup on unmount
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const handleInit = async () => {
    await init({
      backend: selectedBackend,
      pollingRate,
      pressureCurve,
    });
  };

  const handleToggleStream = async () => {
    if (isStreaming) {
      await stop();
    } else {
      await start();
    }
  };

  const statusColor = status === 'Connected' ? '#4f4' : status === 'Error' ? '#f44' : '#888';

  // Don't render anything if not visible
  if (!isVisible) return null;

  return (
    <>
      {/* Toggle button */}
      <button
        className="tablet-toggle-btn"
        onClick={() => setIsOpen(!isOpen)}
        title="Tablet Settings"
      >
        <Tablet size={16} strokeWidth={1.5} />
        <span className="tablet-status-dot" style={{ backgroundColor: statusColor }} />
      </button>

      {/* Panel */}
      {isOpen && (
        <div className="tablet-panel">
          <div className="tablet-panel-header">
            <h3>
              <Tablet size={16} strokeWidth={1.5} />
              Tablet Input
            </h3>
            <button className="close-btn" onClick={() => setIsOpen(false)}>
              <X size={14} strokeWidth={2} />
            </button>
          </div>

          <div className="tablet-panel-content">
            {/* Status */}
            <div className="tablet-status-section">
              <div className="status-row">
                <span className="status-label">Status:</span>
                <span className="status-value" style={{ color: statusColor }}>
                  {status === 'Connected' ? <Wifi size={14} /> : <WifiOff size={14} />}
                  {status}
                </span>
              </div>

              {info && (
                <>
                  <div className="status-row">
                    <span className="status-label">Device:</span>
                    <span className="status-value">{info.name}</span>
                  </div>
                  <div className="status-row">
                    <span className="status-label">Backend:</span>
                    <span className="status-value">{backend}</span>
                  </div>
                  <div className="status-row">
                    <span className="status-label">Pressure:</span>
                    <span className="status-value">
                      {info.pressure_range[0]} - {info.pressure_range[1]}
                    </span>
                  </div>
                </>
              )}

              {inProximity && currentPoint && (
                <div className="status-row live-data">
                  <span className="status-label">Live:</span>
                  <span className="status-value">
                    P: {currentPoint.pressure.toFixed(2)} | Tilt: {currentPoint.tilt_x.toFixed(0)}°,{' '}
                    {currentPoint.tilt_y.toFixed(0)}°
                  </span>
                </div>
              )}
            </div>

            {/* Settings */}
            {!isInitialized && (
              <div className="tablet-settings-section">
                <label className="setting-row">
                  <span>Backend:</span>
                  <select
                    value={selectedBackend}
                    onChange={(e) => setSelectedBackend(e.target.value as BackendType)}
                  >
                    <option value="auto">Auto (prefer WinTab)</option>
                    <option value="wintab">WinTab only</option>
                    <option value="pointerevent">PointerEvent only</option>
                  </select>
                </label>

                <label className="setting-row">
                  <span>Polling Rate:</span>
                  <select
                    value={pollingRate}
                    onChange={(e) => setPollingRate(Number(e.target.value))}
                  >
                    <option value={100}>100 Hz</option>
                    <option value={200}>200 Hz</option>
                    <option value={500}>500 Hz</option>
                    <option value={1000}>1000 Hz</option>
                  </select>
                </label>

                <label className="setting-row">
                  <span>Pressure Curve:</span>
                  <select value={pressureCurve} onChange={(e) => setPressureCurve(e.target.value)}>
                    <option value="linear">Linear</option>
                    <option value="soft">Soft</option>
                    <option value="hard">Hard</option>
                    <option value="scurve">S-Curve</option>
                  </select>
                </label>
              </div>
            )}

            {/* Actions */}
            <div className="tablet-actions">
              {!isInitialized ? (
                <button className="action-btn primary" onClick={handleInit}>
                  <Settings size={14} />
                  Initialize
                </button>
              ) : (
                <>
                  <button
                    className={`action-btn ${isStreaming ? 'danger' : 'primary'}`}
                    onClick={handleToggleStream}
                  >
                    {isStreaming ? (
                      <>
                        <WifiOff size={14} />
                        Stop
                      </>
                    ) : (
                      <>
                        <Wifi size={14} />
                        Start
                      </>
                    )}
                  </button>
                  <button className="action-btn" onClick={refresh}>
                    Refresh
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

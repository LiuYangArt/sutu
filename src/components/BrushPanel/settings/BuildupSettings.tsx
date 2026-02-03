import { useSettingsStore } from '@/stores/settings';

export function BuildupSettings(): JSX.Element {
  const renderMode = useSettingsStore((s) => s.brush.renderMode);
  const cpuOnly = renderMode === 'cpu';

  return (
    <div className="brush-panel-section">
      <div className="section-header-row">
        <h4>Build-up</h4>
      </div>

      <div className="dynamics-group" style={{ gap: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
          Airbrush-style build-up effects. When enabled, holding the brush still will continue to
          accumulate alpha over time (soft edges fill in gradually).
        </div>

        {!cpuOnly && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
            Note: v1 is CPU-only. Switch Render Mode to CPU for this to take effect.
          </div>
        )}
      </div>
    </div>
  );
}

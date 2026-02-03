export function BuildupSettings(): JSX.Element {
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
      </div>
    </div>
  );
}

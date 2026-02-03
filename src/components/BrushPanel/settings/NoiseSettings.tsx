export function NoiseSettings(): JSX.Element {
  return (
    <div className="brush-panel-section">
      <div className="section-header-row">
        <h4>Noise</h4>
      </div>

      <div className="dynamics-group" style={{ gap: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
          Adds random grain to brush edges for a more natural look.
        </div>
      </div>
    </div>
  );
}

// import { useToolStore } from '@/stores/tool';

export function WetEdgeSettings(): JSX.Element {
  // const { wetEdgeEnabled, toggleWetEdge } = useToolStore();

  return (
    <div className="brush-panel-section">
      <h4>Wet Edges</h4>

      <div className="setting-row">
        <label className="checkbox-label">
          <span>Enable Wet Edges</span>
        </label>
      </div>

      <p className="setting-description">
        Creates a watercolor-like effect with darker edges and a lighter center, simulating paint
        pooling at the edges of brush strokes.
      </p>
    </div>
  );
}

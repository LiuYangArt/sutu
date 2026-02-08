import { useSettingsStore, RenderMode, GPURenderScaleMode } from '@/stores/settings';

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

export function RendererSettings(): JSX.Element {
  const { renderMode, gpuRenderScaleMode, setRenderMode, setGpuRenderScaleMode } = useSettingsStore(
    (s) => ({
      renderMode: s.brush.renderMode,
      gpuRenderScaleMode: s.brush.gpuRenderScaleMode,
      setRenderMode: s.setRenderMode,
      setGpuRenderScaleMode: s.setGpuRenderScaleMode,
    })
  );

  return (
    <div className="brush-panel-section">
      <h4>Renderer</h4>
      <div className="brush-setting-row">
        <span className="brush-setting-label">Mode</span>
        <select
          value={renderMode}
          onChange={(e) => setRenderMode(e.target.value as RenderMode)}
          className="brush-select"
          title={RENDER_MODES.find((m) => m.id === renderMode)?.description}
        >
          {RENDER_MODES.map((mode) => (
            <option key={mode.id} value={mode.id} title={mode.description}>
              {mode.label}
            </option>
          ))}
        </select>
      </div>

      {renderMode === 'gpu' && (
        <div className="brush-setting-row">
          <span className="brush-setting-label">Downsample</span>
          <select
            value={gpuRenderScaleMode}
            onChange={(e) => setGpuRenderScaleMode(e.target.value as GPURenderScaleMode)}
            className="brush-select"
            title={GPU_RENDER_SCALE_MODES.find((m) => m.id === gpuRenderScaleMode)?.description}
          >
            {GPU_RENDER_SCALE_MODES.map((mode) => (
              <option key={mode.id} value={mode.id} title={mode.description}>
                {mode.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

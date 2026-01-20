/** Pressure toggle button component */
interface PressureToggleProps {
  enabled: boolean;
  onToggle: () => void;
  title: string;
}

export function PressureToggle({ enabled, onToggle, title }: PressureToggleProps): JSX.Element {
  return (
    <button
      className={`pressure-toggle ${enabled ? 'active' : ''}`}
      onClick={onToggle}
      title={title}
    >
      P
    </button>
  );
}

/** Control source option for Shape Dynamics */
export interface ControlSourceOption {
  value: string;
  label: string;
}

interface ControlSourceSelectProps {
  label: string;
  value: string;
  options: ControlSourceOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

/** Control source dropdown for Shape Dynamics parameters */
export function ControlSourceSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: ControlSourceSelectProps): JSX.Element {
  return (
    <div className="control-source-row">
      <span className="control-source-label">{label}</span>
      <select
        className="control-source-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  displayValue: string;
  onChange: (value: number) => void;
  pressureEnabled?: boolean;
  onPressureToggle?: () => void;
  pressureTitle?: string;
}

/** Slider row component for brush parameters */
export function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  displayValue,
  onChange,
  pressureEnabled,
  onPressureToggle,
  pressureTitle,
}: SliderRowProps): JSX.Element {
  return (
    <div className="brush-setting-row">
      <span className="brush-setting-label">{label}</span>
      {onPressureToggle && pressureTitle && (
        <PressureToggle
          enabled={pressureEnabled ?? false}
          onToggle={onPressureToggle}
          title={pressureTitle}
        />
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="brush-setting-value">{displayValue}</span>
    </div>
  );
}

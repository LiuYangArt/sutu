import { useState, useEffect, useMemo } from 'react';
import {
  countToSliderProgress,
  sliderProgressToValue,
  NonLinearSliderConfig,
} from '@/utils/sliderScales';
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

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectRowProps {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

/** Generic select dropdown row */
export function SelectRow({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: SelectRowProps): JSX.Element {
  return (
    <div className={`control-source-row ${disabled ? 'disabled' : ''}`}>
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
  disabled?: boolean;
  nonLinearConfig?: NonLinearSliderConfig;
}

/** Slider row component for brush parameters */
interface EditableValueProps {
  value: number;
  displayValue: string;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}

function EditableValue({ value, displayValue, min, max, disabled, onChange }: EditableValueProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState(value.toString());

  useEffect(() => {
    if (!isEditing) setInputValue(value.toString());
  }, [value, isEditing]);

  const commitEdit = () => {
    let num = parseFloat(inputValue);
    if (isNaN(num)) {
      num = value;
    } else {
      num = Math.max(min, Math.min(max, num));
    }
    onChange(num);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitEdit();
    else if (e.key === 'Escape') {
      setIsEditing(false);
      setInputValue(value.toString());
    }
  };

  if (isEditing) {
    return (
      <input
        type="text"
        className="brush-setting-value-input"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={handleKeyDown}
        autoFocus
      />
    );
  }

  return (
    <span
      className="brush-setting-value"
      onClick={() => !disabled && setIsEditing(true)}
      style={{ cursor: disabled ? 'default' : 'text' }}
      title={disabled ? undefined : 'Click to edit'}
    >
      {displayValue}
    </span>
  );
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
  disabled = false,
  nonLinearConfig,
}: SliderRowProps): JSX.Element {
  // We use a high internal resolution for the slider input to ensure smooth movement
  // even in compressed ranges.
  const INTERNAL_MAX = 10000;

  // Calculate the current slider position (0-INTERNAL_MAX) based on external value
  const sliderPosition = useMemo(() => {
    const progress = countToSliderProgress(value, min, max, nonLinearConfig);
    return Math.round(progress * INTERNAL_MAX);
  }, [value, min, max, nonLinearConfig]);

  const handleSliderChange = (newPosition: number) => {
    const progress = newPosition / INTERNAL_MAX;
    const newValue = sliderProgressToValue(progress, min, max, step, nonLinearConfig);
    onChange(newValue);
  };

  return (
    <div className={`brush-setting-row ${disabled ? 'disabled' : ''}`}>
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
        min={0}
        max={INTERNAL_MAX}
        step={1} // Internal step is always 1 (fine-grained control)
        value={sliderPosition}
        onChange={(e) => handleSliderChange(Number(e.target.value))}
        disabled={disabled}
      />
      <EditableValue
        value={value}
        displayValue={displayValue}
        min={min}
        max={max}
        disabled={disabled}
        onChange={onChange}
      />
    </div>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Paintbrush, SlidersHorizontal } from 'lucide-react';
import { useNonLinearSlider } from '@/hooks/useNonLinearSlider';
import { useToolStore } from '@/stores/tool';
import { usePanelStore } from '@/stores/panel';
import { BRUSH_SIZE_SLIDER_CONFIG } from '@/utils/sliderScales';
import { useI18n } from '@/i18n';

const ICON_PROPS = { size: 18, strokeWidth: 1.5 } as const;
const BRUSH_SIZE_MIN = 1;
const BRUSH_SIZE_MAX = 1000;
const UNIT_PERCENT_MIN = 1;
const UNIT_PERCENT_MAX = 100;
const UNIT_VALUE_MIN = 0.01;
const UNIT_VALUE_MAX = 1;
const UNIT_VALUE_STEP = 0.01;

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseDraftValue(draft: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(draft);
  if (Number.isNaN(parsed)) return fallback;
  return clampValue(parsed, min, max);
}

function percentToUnit(value: number): number {
  return Math.round(value) / 100;
}

interface EditableNumericValueProps {
  value: number;
  displayValue: string;
  min: number;
  max: number;
  editTitle: string;
  onCommit: (value: number) => void;
}

function EditableNumericValue({
  value,
  displayValue,
  min,
  max,
  editTitle,
  onCommit,
}: EditableNumericValueProps): JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value.toString());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing) {
      setDraft(value.toString());
    }
  }, [value, isEditing]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.select();
    }
  }, [isEditing]);

  function commitEdit(): void {
    const nextValue = parseDraftValue(draft, value, min, max);
    onCommit(nextValue);
    setIsEditing(false);
  }

  function cancelEdit(): void {
    setDraft(value.toString());
    setIsEditing(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      commitEdit();
      return;
    }
    if (event.key === 'Escape') {
      cancelEdit();
    }
  }

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        className="setting-value-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitEdit}
        onKeyDown={handleKeyDown}
      />
    );
  }

  return (
    <span
      className="setting-value editable"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => setIsEditing(true)}
      title={editTitle}
    >
      {displayValue}
    </span>
  );
}

/** Pressure toggle button component */
function PressureToggle({
  enabled,
  onToggle,
  title,
}: {
  enabled: boolean;
  onToggle: () => void;
  title: string;
}) {
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

export function BrushToolbar(): JSX.Element {
  const { t } = useI18n();
  const {
    currentTool,
    brushSize,
    eraserSize,
    setCurrentSize,
    brushFlow,
    setBrushFlow,
    brushOpacity,
    setBrushOpacity,
    pressureSizeEnabled,
    togglePressureSize,
    pressureFlowEnabled,
    togglePressureFlow,
    pressureOpacityEnabled,
    togglePressureOpacity,
    eraserBackgroundMode,
    toggleEraserBackgroundMode,
  } = useToolStore();

  // Brush panel toggle
  const brushPanelOpen = usePanelStore((s) => s.panels['brush-panel']?.isOpen);
  const openPanel = usePanelStore((s) => s.openPanel);
  const closePanel = usePanelStore((s) => s.closePanel);

  function toggleBrushPanel(): void {
    if (brushPanelOpen) {
      closePanel('brush-panel');
    } else {
      openPanel('brush-panel');
    }
  }

  function openBrushLibrary(): void {
    const win = window as Window & { __openBrushLibrary?: () => void };
    win.__openBrushLibrary?.();
  }

  // Get current tool size (brush or eraser)
  const currentSize = currentTool === 'eraser' ? eraserSize : brushSize;

  const {
    sliderPosition: sizeSliderPosition,
    internalMax: sizeSliderMax,
    calculateValue: calculateSizeValue,
  } = useNonLinearSlider({
    value: currentSize,
    min: BRUSH_SIZE_MIN,
    max: BRUSH_SIZE_MAX,
    nonLinearConfig: BRUSH_SIZE_SLIDER_CONFIG,
  });

  const roundedCurrentSize = Math.round(currentSize);
  const flowPercent = Math.round(brushFlow * 100);
  const opacityPercent = Math.round(brushOpacity * 100);

  return (
    <div className="toolbar-section brush-settings">
      <div className="setting">
        <span className="setting-label">{t('toolbar.brush.size')}</span>
        <PressureToggle
          enabled={pressureSizeEnabled}
          onToggle={togglePressureSize}
          title={t('toolbar.brush.pressureAffectsSize')}
        />
        <input
          type="range"
          min={0}
          max={sizeSliderMax}
          step={1}
          value={sizeSliderPosition}
          onChange={(e) => setCurrentSize(calculateSizeValue(Number(e.target.value)))}
        />
        <EditableNumericValue
          value={roundedCurrentSize}
          displayValue={`${roundedCurrentSize}px`}
          min={BRUSH_SIZE_MIN}
          max={BRUSH_SIZE_MAX}
          editTitle={t('toolbar.brush.clickToEdit')}
          onCommit={(nextValue) => setCurrentSize(Math.round(nextValue))}
        />
      </div>

      <div className="setting">
        <span className="setting-label">{t('toolbar.brush.flow')}</span>
        <PressureToggle
          enabled={pressureFlowEnabled}
          onToggle={togglePressureFlow}
          title={t('toolbar.brush.pressureAffectsFlow')}
        />
        <input
          type="range"
          min={UNIT_VALUE_MIN}
          max={UNIT_VALUE_MAX}
          step={UNIT_VALUE_STEP}
          value={brushFlow}
          onChange={(e) => setBrushFlow(Number(e.target.value))}
        />
        <EditableNumericValue
          value={flowPercent}
          displayValue={`${flowPercent}%`}
          min={UNIT_PERCENT_MIN}
          max={UNIT_PERCENT_MAX}
          editTitle={t('toolbar.brush.clickToEdit')}
          onCommit={(nextValue) => setBrushFlow(percentToUnit(nextValue))}
        />
      </div>

      <div className="setting">
        <span className="setting-label">{t('toolbar.brush.opacity')}</span>
        <PressureToggle
          enabled={pressureOpacityEnabled}
          onToggle={togglePressureOpacity}
          title={t('toolbar.brush.pressureAffectsOpacity')}
        />
        <input
          type="range"
          min={UNIT_VALUE_MIN}
          max={UNIT_VALUE_MAX}
          step={UNIT_VALUE_STEP}
          value={brushOpacity}
          onChange={(e) => setBrushOpacity(Number(e.target.value))}
        />
        <EditableNumericValue
          value={opacityPercent}
          displayValue={`${opacityPercent}%`}
          min={UNIT_PERCENT_MIN}
          max={UNIT_PERCENT_MAX}
          editTitle={t('toolbar.brush.clickToEdit')}
          onCommit={(nextValue) => setBrushOpacity(percentToUnit(nextValue))}
        />
      </div>

      {currentTool === 'eraser' && (
        <button
          className="tool-option-btn"
          onClick={toggleEraserBackgroundMode}
          title={t('toolbar.brush.eraserBackgroundMode')}
        >
          {eraserBackgroundMode === 'background-color'
            ? t('toolbar.brush.eraseToBgColor')
            : t('toolbar.brush.eraseToTransparent')}
        </button>
      )}

      <button
        className="tool-btn"
        onClick={openBrushLibrary}
        title={t('toolbar.brush.openBrushLibrary')}
      >
        <Paintbrush {...ICON_PROPS} />
      </button>

      <button
        className={`tool-btn ${brushPanelOpen ? 'active' : ''}`}
        onClick={toggleBrushPanel}
        title={t('toolbar.brush.openBrushSettings')}
      >
        <SlidersHorizontal {...ICON_PROPS} />
      </button>
    </div>
  );
}

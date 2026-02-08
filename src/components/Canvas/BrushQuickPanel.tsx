import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { ArrowLeftRight, RotateCcw, Search, X } from 'lucide-react';
import { useToolStore } from '@/stores/tool';
import {
  useBrushLibraryStore,
  type BrushLibraryGroup,
  type BrushLibraryPreset,
} from '@/stores/brushLibrary';
import { BrushPresetThumbnail } from '@/components/BrushPanel/BrushPresetThumbnail';
import { BRUSH_SIZE_SLIDER_CONFIG } from '@/utils/sliderScales';
import { useNonLinearSlider } from '@/hooks/useNonLinearSlider';
import { SaturationSquare } from '@/components/ColorPanel/SaturationSquare';
import { VerticalHueSlider } from '@/components/ColorPanel/VerticalHueSlider';
import { hexToHsva, hsvaToHex, normalizeHex } from '@/utils/colorUtils';
import { calculateBrushQuickPanelPosition } from './brushQuickPanelPosition';
import './BrushQuickPanel.css';

interface BrushQuickPanelProps {
  isOpen: boolean;
  anchorX: number;
  anchorY: number;
  onRequestClose: () => void;
}

interface GroupedBrushPresets {
  name: string;
  presets: BrushLibraryPreset[];
}

const DEFAULT_PANEL_WIDTH = 680;
const DEFAULT_PANEL_HEIGHT = 620;

function groupPresets(
  presets: BrushLibraryPreset[],
  groups: BrushLibraryGroup[],
  searchQuery: string
): GroupedBrushPresets[] {
  const query = searchQuery.trim().toLowerCase();
  const filtered =
    query.length === 0
      ? presets
      : presets.filter((preset) => {
          const nameMatch = preset.name.toLowerCase().includes(query);
          const groupMatch = (preset.group ?? '').toLowerCase().includes(query);
          return nameMatch || groupMatch;
        });

  const presetMap = new Map(filtered.map((preset) => [preset.id, preset]));
  const grouped: GroupedBrushPresets[] = [];
  const groupedIds = new Set<string>();

  for (const group of groups) {
    const sectionPresets = group.presetIds
      .map((id) => presetMap.get(id))
      .filter((preset): preset is BrushLibraryPreset => !!preset);

    if (sectionPresets.length === 0) continue;
    grouped.push({
      name: group.name,
      presets: sectionPresets,
    });
    sectionPresets.forEach((preset) => groupedIds.add(preset.id));
  }

  const ungrouped = filtered.filter((preset) => !groupedIds.has(preset.id));
  if (ungrouped.length > 0) {
    grouped.push({
      name: 'Ungrouped',
      presets: ungrouped,
    });
  }

  return grouped;
}

export function BrushQuickPanel({
  isOpen,
  anchorX,
  anchorY,
  onRequestClose,
}: BrushQuickPanelProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [position, setPosition] = useState({ left: 12, top: 12 });

  const {
    currentTool,
    brushSize,
    eraserSize,
    setCurrentSize,
    brushColor,
    backgroundColor,
    setBrushColor,
    swapColors,
    resetColors,
  } = useToolStore();
  const currentSize = currentTool === 'eraser' ? eraserSize : brushSize;

  const presets = useBrushLibraryStore((state) => state.presets);
  const groups = useBrushLibraryStore((state) => state.groups);
  const selectedPresetId = useBrushLibraryStore((state) => state.selectedPresetId);
  const isLoading = useBrushLibraryStore((state) => state.isLoading);
  const error = useBrushLibraryStore((state) => state.error);
  const loadLibrary = useBrushLibraryStore((state) => state.loadLibrary);
  const applyPresetById = useBrushLibraryStore((state) => state.applyPresetById);
  const clearError = useBrushLibraryStore((state) => state.clearError);

  const groupedPresets = useMemo(
    () => groupPresets(presets, groups, searchQuery),
    [presets, groups, searchQuery]
  );

  const { sliderPosition, internalMax, calculateValue } = useNonLinearSlider({
    value: currentSize,
    min: 1,
    max: 1000,
    nonLinearConfig: BRUSH_SIZE_SLIDER_CONFIG,
  });

  const [hsva, setHsva] = useState(() => hexToHsva(brushColor));
  const [hexInput, setHexInput] = useState(brushColor.replace('#', ''));
  const lastInitiatedHex = useRef<string | null>(null);

  useEffect(() => {
    setHexInput(brushColor.replace('#', ''));
    const currentHex = brushColor.toLowerCase();
    const initiatedHex = lastInitiatedHex.current?.toLowerCase();
    if (initiatedHex && initiatedHex === currentHex) {
      lastInitiatedHex.current = null;
      return;
    }
    lastInitiatedHex.current = null;
    setHsva(hexToHsva(brushColor));
  }, [brushColor]);

  useEffect(() => {
    if (!isOpen) return;
    setSearchQuery('');
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (presets.length > 0 || isLoading) return;
    void loadLibrary();
  }, [isOpen, presets.length, isLoading, loadLibrary]);

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => {
      const panelWidth = panelRef.current?.offsetWidth ?? DEFAULT_PANEL_WIDTH;
      const panelHeight = panelRef.current?.offsetHeight ?? DEFAULT_PANEL_HEIGHT;
      const next = calculateBrushQuickPanelPosition({
        anchorX,
        anchorY,
        panelWidth,
        panelHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
      setPosition(next);
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, anchorX, anchorY, groupedPresets.length, isLoading, error]);

  useEffect(() => {
    if (!isOpen) return;

    const handleWindowPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      onRequestClose();
    };

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onRequestClose();
      }
    };

    window.addEventListener('pointerdown', handleWindowPointerDown, { capture: true });
    window.addEventListener('keydown', handleWindowKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handleWindowPointerDown, { capture: true });
      window.removeEventListener('keydown', handleWindowKeyDown);
    };
  }, [isOpen, onRequestClose]);

  const handleSaturationChange = useCallback(
    (nextHsva: { h: number; s: number; v: number; a: number }) => {
      const hex = hsvaToHex(nextHsva);
      lastInitiatedHex.current = hex;
      setHsva(nextHsva);
      setBrushColor(hex);
    },
    [setBrushColor]
  );

  const handleHueChange = useCallback(
    (nextHue: number) => {
      const nextHsva = { ...hsva, h: nextHue };
      const hex = hsvaToHex(nextHsva);
      lastInitiatedHex.current = hex;
      setHsva(nextHsva);
      setBrushColor(hex);
    },
    [hsva, setBrushColor]
  );

  const handleHexChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setHexInput(value);
    const clean = value.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length === 3 || clean.length === 6) {
      setBrushColor(`#${normalizeHex(clean)}`);
    }
  };

  const handleHexBlur = () => {
    setHexInput(brushColor.replace('#', ''));
  };

  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      className="brush-quick-panel"
      style={{ left: position.left, top: position.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="brush-quick-panel-header">
        <h3>Brush Quick Panel</h3>
        <button className="brush-quick-close-btn" onClick={onRequestClose} title="Close">
          <X size={16} />
        </button>
      </div>

      <div className="brush-quick-panel-body">
        <div className="brush-quick-top">
          <section className="brush-quick-color-card">
            <div className="brush-quick-color-title">Color</div>
            <div className="brush-quick-picker-area">
              <div className="brush-quick-saturation-wrapper">
                <SaturationSquare hsva={hsva} onChange={handleSaturationChange} />
              </div>
              <div className="brush-quick-hue-wrapper">
                <VerticalHueSlider hue={hsva.h} onChange={handleHueChange} />
              </div>
            </div>
            <div className="brush-quick-color-inputs">
              <div className="brush-quick-color-swatches">
                <div
                  className="brush-quick-color-swatch foreground"
                  style={{ backgroundColor: brushColor }}
                  title="Foreground"
                />
                <div
                  className="brush-quick-color-swatch background"
                  style={{ backgroundColor: backgroundColor }}
                  title="Background"
                />
              </div>
              <div className="brush-quick-color-actions">
                <button onClick={swapColors} title="Swap Colors (X)">
                  <ArrowLeftRight size={12} />
                </button>
                <button onClick={resetColors} title="Reset Colors (D)">
                  <RotateCcw size={12} />
                </button>
              </div>
              <div className="brush-quick-hex-input-wrapper">
                <span>#</span>
                <input
                  type="text"
                  value={hexInput}
                  onChange={handleHexChange}
                  onBlur={handleHexBlur}
                  maxLength={6}
                />
              </div>
            </div>
          </section>

          <section className="brush-quick-size-card">
            <div className="brush-quick-size-title-row">
              <span>Size</span>
              <span>{currentSize}px</span>
            </div>
            <input
              type="range"
              min={0}
              max={internalMax}
              step={1}
              value={sliderPosition}
              onChange={(event) => setCurrentSize(calculateValue(Number(event.target.value)))}
            />
            <input
              className="brush-quick-size-input"
              type="number"
              min={1}
              max={1000}
              value={currentSize}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) {
                  setCurrentSize(next);
                }
              }}
            />
          </section>
        </div>

        <div className="brush-quick-search">
          <Search size={14} />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search brushes..."
          />
        </div>

        {error && (
          <div className="brush-quick-error">
            <span>{error}</span>
            <button onClick={clearError}>x</button>
          </div>
        )}

        <div className="brush-quick-library">
          {isLoading ? (
            <div className="brush-quick-empty">Loading brush library...</div>
          ) : groupedPresets.length === 0 ? (
            <div className="brush-quick-empty">No brushes matched the search.</div>
          ) : (
            groupedPresets.map((group) => (
              <div key={group.name} className="brush-quick-group">
                <div className="brush-quick-group-title">
                  <span>{group.name}</span>
                  <span>{group.presets.length}</span>
                </div>
                <div className="brush-quick-grid">
                  {group.presets.map((preset) => (
                    <button
                      key={preset.id}
                      className={`brush-quick-grid-item ${selectedPresetId === preset.id ? 'selected' : ''}`}
                      onClick={() => applyPresetById(preset.id)}
                      title={preset.name}
                    >
                      <BrushPresetThumbnail
                        preset={preset}
                        size={44}
                        className="brush-quick-thumb"
                      />
                      <span>{preset.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

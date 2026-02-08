import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Search } from 'lucide-react';
import { useToolStore } from '@/stores/tool';
import {
  useBrushLibraryStore,
  type BrushLibraryGroup,
  type BrushLibraryPreset,
} from '@/stores/brushLibrary';
import { BrushPresetThumbnail } from '@/components/BrushPanel/BrushPresetThumbnail';
import { BRUSH_SIZE_SLIDER_CONFIG } from '@/utils/sliderScales';
import { SliderRow } from '@/components/BrushPanel/BrushPanelComponents';
import { SaturationSquare } from '@/components/ColorPanel/SaturationSquare';
import { VerticalHueSlider } from '@/components/ColorPanel/VerticalHueSlider';
import { hexToHsva, hsvaToHex } from '@/utils/colorUtils';
import { calculateBrushQuickPanelPosition } from './brushQuickPanelPosition';
import './BrushQuickPanel.css';

interface BrushQuickPanelProps {
  isOpen: boolean;
  anchorX: number;
  anchorY: number;
  onRequestClose: () => void;
  onHoveringChange?: (hovering: boolean) => void;
}

interface GroupedBrushPresets {
  name: string;
  presets: BrushLibraryPreset[];
}

interface PanelSize {
  width: number;
  height: number;
}

interface PanelDragState {
  pointerId: number;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
}

const DEFAULT_PANEL_SIZE: PanelSize = {
  width: 560,
  height: 434,
};

const MIN_PANEL_WIDTH = 420;
const MIN_PANEL_HEIGHT = 360;
const PANEL_SIZE_STORAGE_KEY = 'paintboard-brush-quick-panel-size-v1';

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

function clampPanelSize(size: PanelSize, viewportWidth: number, viewportHeight: number): PanelSize {
  const maxWidth = Math.max(MIN_PANEL_WIDTH, viewportWidth - 24);
  const maxHeight = Math.max(MIN_PANEL_HEIGHT, viewportHeight - 24);
  return {
    width: Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, Math.round(size.width))),
    height: Math.min(maxHeight, Math.max(MIN_PANEL_HEIGHT, Math.round(size.height))),
  };
}

function readPanelSizeFromStorage(): PanelSize {
  if (typeof window === 'undefined') return DEFAULT_PANEL_SIZE;
  try {
    const raw = window.localStorage.getItem(PANEL_SIZE_STORAGE_KEY);
    if (!raw) return DEFAULT_PANEL_SIZE;
    const parsed = JSON.parse(raw) as Partial<PanelSize>;
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') {
      return DEFAULT_PANEL_SIZE;
    }
    return clampPanelSize(parsed as PanelSize, window.innerWidth, window.innerHeight);
  } catch {
    return DEFAULT_PANEL_SIZE;
  }
}

function writePanelSizeToStorage(size: PanelSize): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PANEL_SIZE_STORAGE_KEY, JSON.stringify(size));
  } catch {
    // Ignore storage failures.
  }
}

function clampPanelPosition(
  left: number,
  top: number,
  size: PanelSize,
  viewportWidth: number,
  viewportHeight: number
): { left: number; top: number } {
  const margin = 12;
  const maxLeft = Math.max(margin, viewportWidth - size.width - margin);
  const maxTop = Math.max(margin, viewportHeight - size.height - margin);
  return {
    left: Math.min(maxLeft, Math.max(margin, left)),
    top: Math.min(maxTop, Math.max(margin, top)),
  };
}

function isPanelInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    'button, input, textarea, select, .saturation-square, .vertical-hue-slider, .brush-quick-search, .brush-quick-library'
  );
}

export function BrushQuickPanel({
  isOpen,
  anchorX,
  anchorY,
  onRequestClose,
  onHoveringChange,
}: BrushQuickPanelProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: 12, top: 12 });
  const [panelSize, setPanelSize] = useState<PanelSize>(() => readPanelSizeFromStorage());
  const panelSizeRef = useRef(panelSize);
  const lastAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<PanelDragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const { currentTool, brushSize, eraserSize, setCurrentSize, brushColor, setBrushColor } =
    useToolStore();
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

  const [hsva, setHsva] = useState(() => hexToHsva(brushColor));
  const lastInitiatedHex = useRef<string | null>(null);

  const syncPanelSizeFromDom = useCallback((): PanelSize | null => {
    const panel = panelRef.current;
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const measured = clampPanelSize(
      { width: rect.width, height: rect.height },
      window.innerWidth,
      window.innerHeight
    );
    setPanelSize((prev) =>
      prev.width === measured.width && prev.height === measured.height ? prev : measured
    );
    setPosition((prev) =>
      clampPanelPosition(prev.left, prev.top, measured, window.innerWidth, window.innerHeight)
    );
    return measured;
  }, []);

  useEffect(() => {
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
    panelSizeRef.current = panelSize;
    writePanelSizeToStorage(panelSize);
  }, [panelSize]);

  useEffect(() => {
    if (!isOpen) return;
    if (presets.length > 0 || isLoading) return;
    void loadLibrary();
  }, [isOpen, presets.length, isLoading, loadLibrary]);

  useEffect(() => {
    if (!isOpen) {
      lastAnchorRef.current = null;
      return;
    }
    const anchorChanged =
      !lastAnchorRef.current ||
      lastAnchorRef.current.x !== anchorX ||
      lastAnchorRef.current.y !== anchorY;
    if (!anchorChanged) return;
    lastAnchorRef.current = { x: anchorX, y: anchorY };

    const latestSize = syncPanelSizeFromDom() ?? panelSizeRef.current;
    const next = calculateBrushQuickPanelPosition({
      anchorX,
      anchorY,
      panelWidth: latestSize.width,
      panelHeight: latestSize.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setPosition(next);
  }, [isOpen, anchorX, anchorY, panelSize.width, panelSize.height, syncPanelSizeFromDom]);

  useEffect(() => {
    if (!isOpen) return;

    const handleWindowPointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (path.includes(panel)) return;
      syncPanelSizeFromDom();
      onRequestClose();
    };

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        syncPanelSizeFromDom();
        onRequestClose();
      }
    };

    const handleWindowPointerUp = () => {
      syncPanelSizeFromDom();
    };

    window.addEventListener('pointerdown', handleWindowPointerDown, { capture: true });
    window.addEventListener('keydown', handleWindowKeyDown);
    window.addEventListener('pointerup', handleWindowPointerUp, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', handleWindowPointerDown, { capture: true });
      window.removeEventListener('keydown', handleWindowKeyDown);
      window.removeEventListener('pointerup', handleWindowPointerUp, { capture: true });
    };
  }, [isOpen, onRequestClose, syncPanelSizeFromDom]);

  useEffect(() => {
    if (isOpen) return;
    onHoveringChange?.(false);
  }, [isOpen, onHoveringChange]);

  useEffect(() => {
    if (!isOpen) return;

    const handleResize = () => {
      const clampedSize = clampPanelSize(
        panelSizeRef.current,
        window.innerWidth,
        window.innerHeight
      );
      setPanelSize((prev) =>
        prev.width === clampedSize.width && prev.height === clampedSize.height ? prev : clampedSize
      );
      setPosition((prev) =>
        clampPanelPosition(prev.left, prev.top, clampedSize, window.innerWidth, window.innerHeight)
      );
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (!panelRef.current) return;
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const measured = clampPanelSize(
        { width: entry.contentRect.width, height: entry.contentRect.height },
        window.innerWidth,
        window.innerHeight
      );

      setPanelSize((prev) => {
        if (prev.width === measured.width && prev.height === measured.height) {
          return prev;
        }
        return measured;
      });
      setPosition((prev) =>
        clampPanelPosition(prev.left, prev.top, measured, window.innerWidth, window.innerHeight)
      );
    });

    observer.observe(panelRef.current);
    return () => {
      observer.disconnect();
    };
  }, [isOpen]);

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

  const handlePanelPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    if (isPanelInteractiveTarget(event.target)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const resizeHandleSize = 20;
    const isOnResizeHandle =
      event.clientX >= rect.right - resizeHandleSize &&
      event.clientY >= rect.bottom - resizeHandleSize;
    if (isOnResizeHandle) return;

    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: position.left,
      startTop: position.top,
    };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePanelPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const next = clampPanelPosition(
      drag.startLeft + deltaX,
      drag.startTop + deltaY,
      panelSizeRef.current,
      window.innerWidth,
      window.innerHeight
    );
    setPosition(next);
  };

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    dragRef.current = null;
    setIsDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore release errors.
    }
  };

  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      className={`brush-quick-panel ${isDragging ? 'dragging' : ''}`}
      style={{
        left: position.left,
        top: position.top,
        width: panelSize.width,
        height: panelSize.height,
      }}
      onPointerDown={handlePanelPointerDown}
      onPointerMove={handlePanelPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onPointerEnter={() => onHoveringChange?.(true)}
      onPointerLeave={() => onHoveringChange?.(false)}
      onContextMenu={(event) => event.preventDefault()}
    >
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
          </section>

          <section className="brush-quick-size-card">
            <SliderRow
              label="Size"
              value={currentSize}
              min={1}
              max={1000}
              displayValue={`${Math.round(currentSize)}px`}
              onChange={(nextSize) => setCurrentSize(Math.round(nextSize))}
              nonLinearConfig={BRUSH_SIZE_SLIDER_CONFIG}
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
                      aria-label={preset.name}
                      className={`brush-quick-grid-item ${selectedPresetId === preset.id ? 'selected' : ''}`}
                      onClick={() => applyPresetById(preset.id)}
                      title={preset.name}
                    >
                      <BrushPresetThumbnail
                        preset={preset}
                        size={30}
                        className="brush-quick-thumb"
                      />
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

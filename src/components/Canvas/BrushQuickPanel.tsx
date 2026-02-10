import { useEffect, useMemo, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useToolStore } from '@/stores/tool';
import {
  useBrushLibraryStore,
  useSelectedPresetIdForCurrentTool,
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

interface PanelPosition {
  left: number;
  top: number;
}

interface ViewportSize {
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

interface HsvaColor {
  h: number;
  s: number;
  v: number;
  a: number;
}

const DEFAULT_PANEL_SIZE: PanelSize = {
  width: 560,
  height: 434,
};

const PANEL_MARGIN = 12;
const MIN_PANEL_WIDTH = 420;
const MIN_PANEL_HEIGHT = 360;
const PANEL_RESIZE_HANDLE_SIZE = 20;
const PANEL_SIZE_STORAGE_KEY = 'paintboard-brush-quick-panel-size-v1';
const PANEL_INTERACTIVE_SELECTOR =
  'button, input, textarea, select, .saturation-square, .vertical-hue-slider, .brush-quick-search, .brush-quick-library';
const PANEL_SCROLLABLE_SELECTOR = '.brush-quick-library';

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
  const maxLeft = Math.max(PANEL_MARGIN, viewportWidth - size.width - PANEL_MARGIN);
  const maxTop = Math.max(PANEL_MARGIN, viewportHeight - size.height - PANEL_MARGIN);
  return {
    left: Math.min(maxLeft, Math.max(PANEL_MARGIN, left)),
    top: Math.min(maxTop, Math.max(PANEL_MARGIN, top)),
  };
}

function getViewportSize(): ViewportSize {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function isSamePanelSize(a: PanelSize, b: PanelSize): boolean {
  return a.width === b.width && a.height === b.height;
}

function isSamePanelPosition(a: PanelPosition, b: PanelPosition): boolean {
  return a.left === b.left && a.top === b.top;
}

function isSameHsva(a: HsvaColor, b: HsvaColor): boolean {
  return a.h === b.h && a.s === b.s && a.v === b.v && a.a === b.a;
}

function isSameColorToken(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isPanelInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(PANEL_INTERACTIVE_SELECTOR);
}

function parsePixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isPointerOnElementScrollbar(
  element: HTMLElement,
  clientX: number,
  clientY: number
): boolean {
  const rect = element.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return false;
  }

  const hasVerticalOverflow = element.scrollHeight > element.clientHeight;
  const hasHorizontalOverflow = element.scrollWidth > element.clientWidth;
  if (!hasVerticalOverflow && !hasHorizontalOverflow) return false;

  const style = window.getComputedStyle(element);
  const borderLeft = parsePixels(style.borderLeftWidth);
  const borderRight = parsePixels(style.borderRightWidth);
  const borderTop = parsePixels(style.borderTopWidth);
  const borderBottom = parsePixels(style.borderBottomWidth);

  const scrollbarWidth = Math.max(
    0,
    element.offsetWidth - element.clientWidth - borderLeft - borderRight
  );
  if (hasVerticalOverflow && scrollbarWidth > 0) {
    const scrollbarLeft = rect.right - borderRight - scrollbarWidth;
    const scrollbarRight = rect.right - borderRight;
    if (clientX >= scrollbarLeft && clientX <= scrollbarRight) {
      return true;
    }
  }

  const scrollbarHeight = Math.max(
    0,
    element.offsetHeight - element.clientHeight - borderTop - borderBottom
  );
  if (hasHorizontalOverflow && scrollbarHeight > 0) {
    const scrollbarTop = rect.bottom - borderBottom - scrollbarHeight;
    const scrollbarBottom = rect.bottom - borderBottom;
    if (clientY >= scrollbarTop && clientY <= scrollbarBottom) {
      return true;
    }
  }

  return false;
}

function isPointerOnPanelScrollbar(
  panel: HTMLDivElement,
  event: React.PointerEvent<HTMLDivElement>
): boolean {
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
  const containers = panel.querySelectorAll<HTMLElement>(PANEL_SCROLLABLE_SELECTOR);
  for (const container of containers) {
    if (isPointerOnElementScrollbar(container, event.clientX, event.clientY)) {
      return true;
    }
  }
  return false;
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [position, setPosition] = useState<PanelPosition>({
    left: PANEL_MARGIN,
    top: PANEL_MARGIN,
  });
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
  const selectedPresetId = useSelectedPresetIdForCurrentTool();
  const isLoading = useBrushLibraryStore((state) => state.isLoading);
  const error = useBrushLibraryStore((state) => state.error);
  const loadLibrary = useBrushLibraryStore((state) => state.loadLibrary);
  const applyPresetById = useBrushLibraryStore((state) => state.applyPresetById);
  const clearError = useBrushLibraryStore((state) => state.clearError);

  const groupedPresets = useMemo(
    () => groupPresets(presets, groups, searchQuery),
    [presets, groups, searchQuery]
  );

  const [hsva, setHsva] = useState<HsvaColor>(() => hexToHsva(brushColor));
  const hsvaRef = useRef<HsvaColor>(hsva);
  hsvaRef.current = hsva;
  const brushColorRef = useRef(brushColor);
  brushColorRef.current = brushColor;
  const queuedBrushColorRef = useRef<string | null>(null);
  const brushColorRafRef = useRef<number | null>(null);

  const updatePanelLayout = useCallback((nextSize: PanelSize, viewport: ViewportSize): void => {
    setPanelSize((prev) => (isSamePanelSize(prev, nextSize) ? prev : nextSize));
    setPosition((prev) => {
      const next = clampPanelPosition(
        prev.left,
        prev.top,
        nextSize,
        viewport.width,
        viewport.height
      );
      return isSamePanelPosition(prev, next) ? prev : next;
    });
  }, []);

  const syncPanelSizeFromDom = useCallback((): PanelSize | null => {
    const panel = panelRef.current;
    if (!panel) return null;
    const viewport = getViewportSize();
    const rect = panel.getBoundingClientRect();
    const measured = clampPanelSize(
      { width: rect.width, height: rect.height },
      viewport.width,
      viewport.height
    );
    updatePanelLayout(measured, viewport);
    return measured;
  }, [updatePanelLayout]);

  useEffect(() => {
    const nextHsva = hexToHsva(brushColor);
    setHsva((prev) => (isSameHsva(prev, nextHsva) ? prev : nextHsva));
  }, [brushColor]);

  const flushQueuedBrushColor = useCallback(() => {
    brushColorRafRef.current = null;
    const nextColor = queuedBrushColorRef.current;
    queuedBrushColorRef.current = null;
    if (!nextColor) return;
    if (isSameColorToken(brushColorRef.current, nextColor)) return;
    setBrushColor(nextColor);
  }, [setBrushColor]);

  const queueBrushColorUpdate = useCallback(
    (nextColor: string) => {
      queuedBrushColorRef.current = nextColor;
      if (brushColorRafRef.current !== null) return;
      brushColorRafRef.current = window.requestAnimationFrame(flushQueuedBrushColor);
    },
    [flushQueuedBrushColor]
  );

  useEffect(() => {
    return () => {
      if (brushColorRafRef.current !== null) {
        window.cancelAnimationFrame(brushColorRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setSearchQuery('');
    setCollapsedGroups(new Set());
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

  useLayoutEffect(() => {
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

    const viewport = getViewportSize();
    const latestSize = syncPanelSizeFromDom() ?? panelSizeRef.current;
    const next = calculateBrushQuickPanelPosition({
      anchorX,
      anchorY,
      panelWidth: latestSize.width,
      panelHeight: latestSize.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
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
      const viewport = getViewportSize();
      const clampedSize = clampPanelSize(panelSizeRef.current, viewport.width, viewport.height);
      updatePanelLayout(clampedSize, viewport);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [isOpen, updatePanelLayout]);

  useEffect(() => {
    if (!isOpen) return;
    if (!panelRef.current) return;
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const viewport = getViewportSize();

      // Use border-box size to avoid content-box drift under global border-box sizing.
      // contentRect excludes border and would cause a feedback loop that continuously shrinks.
      const rect = panel.getBoundingClientRect();
      const measured = clampPanelSize(
        { width: rect.width, height: rect.height },
        viewport.width,
        viewport.height
      );
      updatePanelLayout(measured, viewport);
    });

    observer.observe(panelRef.current);
    return () => {
      observer.disconnect();
    };
  }, [isOpen, updatePanelLayout]);

  const handleSaturationChange = useCallback(
    (nextHsva: HsvaColor) => {
      const hex = hsvaToHex(nextHsva);
      queueBrushColorUpdate(hex);
    },
    [queueBrushColorUpdate]
  );

  const handleHueChange = useCallback(
    (nextHue: number) => {
      const nextHsva = { ...hsvaRef.current, h: nextHue };
      const hex = hsvaToHex(nextHsva);
      queueBrushColorUpdate(hex);
    },
    [queueBrushColorUpdate]
  );

  const handlePanelPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    if (isPanelInteractiveTarget(event.target)) return;
    if (isPointerOnPanelScrollbar(event.currentTarget, event)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const isOnResizeHandle =
      event.clientX >= rect.right - PANEL_RESIZE_HANDLE_SIZE &&
      event.clientY >= rect.bottom - PANEL_RESIZE_HANDLE_SIZE;
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
    const viewport = getViewportSize();

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const next = clampPanelPosition(
      drag.startLeft + deltaX,
      drag.startTop + deltaY,
      panelSizeRef.current,
      viewport.width,
      viewport.height
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

  const toggleGroupCollapsed = useCallback((groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  }, []);

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
            groupedPresets.map((group) => {
              const isCollapsed = collapsedGroups.has(group.name);
              return (
                <div key={group.name} className="brush-quick-group">
                  <div className="brush-quick-group-title">
                    <div className="brush-quick-group-title-main">
                      <span className="brush-quick-group-name">{group.name}</span>
                      <span className="brush-quick-group-count">{group.presets.length}</span>
                    </div>
                    <button
                      className="brush-quick-group-toggle-btn"
                      onClick={() => toggleGroupCollapsed(group.name)}
                      title={isCollapsed ? 'Expand group' : 'Collapse group'}
                      aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} group ${group.name}`}
                    >
                      {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </button>
                  </div>

                  {!isCollapsed && (
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
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

import Style from './FloatingPanel.module.css';
import { X, Minus, Maximize2 } from 'lucide-react';
import { usePanelStore } from '../../../stores/panel';
import type { PanelGeometry } from '../../../stores/panel';
import { usePanelDrag } from './usePanelDrag';
import { usePanelResize, ResizeDirection } from './usePanelResize';
import React, { useCallback } from 'react';
import {
  calculateNewAlignment,
  calculateSnapAlignment,
  getAbsolutePositionFromAlignment,
} from './utils';

interface FloatingPanelProps {
  panelId: string;
  title?: string;
  children: React.ReactNode;
  minWidth?: number;
  minHeight?: number;
}

// Separate component to prevent re-creation on parent render
const ResizeHandle = React.memo(
  ({
    dir,
    onResize,
  }: {
    dir: ResizeDirection;
    onResize: (delta: Partial<PanelGeometry>) => void;
  }) => {
    const dragEvents = usePanelResize({
      direction: dir,
      onResize,
    });

    return <div className={`${Style.resizeHandle} ${Style['resize-' + dir]}`} {...dragEvents} />;
  }
);

ResizeHandle.displayName = 'ResizeHandle';

export const FloatingPanel = React.memo(function FloatingPanel({
  panelId,
  title,
  children,
  minWidth = 200,
  minHeight = 150,
}: FloatingPanelProps) {
  const panel = usePanelStore((s) => s.panels[panelId]);
  const updateGeometry = usePanelStore((s) => s.updateGeometry);
  const updateAlignment = usePanelStore((s) => s.updateAlignment); // New action
  const closePanel = usePanelStore((s) => s.closePanel);
  const minimizePanel = usePanelStore((s) => s.minimizePanel);
  const bringToFront = usePanelStore((s) => s.bringToFront);

  const handleFocus = useCallback(() => {
    bringToFront(panelId);
  }, [bringToFront, panelId]);

  // Handle Drag Move - updates visual position (x, y) immediately for smoothness
  const handleMove = useCallback(
    (dx: number, dy: number) => {
      if (panel) {
        updateGeometry(panelId, {
          x: panel.x + dx,
          y: panel.y + dy,
        });
      }
    },
    [panelId, panel, updateGeometry]
  );

  // Handle Drag End - Snap to anchor
  // We calculate which quadrant the panel is in and set the alignment accordingly
  // Handle Drag End - Snap to anchor
  const handleDragEnd = useCallback(() => {
    if (!panel) return;

    const newAlignment = calculateSnapAlignment(panel, {
      width: window.innerWidth,
      height: window.innerHeight,
    });

    updateAlignment(panelId, newAlignment);
  }, [panel, panelId, updateAlignment]);

  // Handle Drag Start - Convert alignment to absolute position if needed
  const handleDragStart = useCallback(() => {
    bringToFront(panelId);

    if (panel && panel.alignment) {
      const { x, y } = getAbsolutePositionFromAlignment(panel.alignment, panel, {
        width: window.innerWidth,
        height: window.innerHeight,
      });

      // Update geometry to match visual position and clear alignment
      // passing undefined to alignment switches to absolute positioning mode
      updateGeometry(panelId, { x, y });
      updateAlignment(panelId, undefined as any);
    }
  }, [panelId, panel, updateGeometry, updateAlignment, bringToFront]);

  const {
    onPointerDown: onTitleDown,
    onPointerMove: onTitleMove,
    onPointerUp: onTitleUp,
    onPointerLeave: onTitleLeave,
  } = usePanelDrag({
    onDrag: handleMove,
    onDragStart: handleDragStart,
    onDragEnd: handleDragEnd,
  });

  // Calculate style based on alignment if available
  // If alignment exists, it overrides x/y for rendering to ensure anchoring
  const style: React.CSSProperties = {
    position: 'fixed',
    width: panel?.width,
    height: panel?.isCollapsed ? 'auto' : panel?.height,
    zIndex: panel?.zIndex,
  };

  if (panel?.alignment) {
    const { horizontal, vertical, offsetX, offsetY } = panel.alignment;
    if (horizontal === 'left') style.left = offsetX;
    else style.right = offsetX;

    if (vertical === 'top') style.top = offsetY;
    else style.bottom = offsetY;
  } else {
    // Fallback to absolute x, y
    style.left = panel?.x;
    style.top = panel?.y;
  }

  // Handle Resize - Update geometry (width/height)
  // Note: Resize might also affect position (e.g. resizing from left changes x)
  const handleResize = useCallback(
    (delta: Partial<PanelGeometry>) => {
      if (!panel) return;
      const newGeo = { ...panel };
      if (delta.x !== undefined) newGeo.x += delta.x;
      if (delta.y !== undefined) newGeo.y += delta.y;
      if (delta.width !== undefined) {
        let newWidth = newGeo.width + delta.width;
        newWidth = Math.max(minWidth, newWidth);
        if (panel.minWidth) newWidth = Math.max(panel.minWidth, newWidth);
        if (panel.maxWidth) newWidth = Math.min(panel.maxWidth, newWidth);
        newGeo.width = newWidth;
      }

      if (delta.height !== undefined) {
        let newHeight = newGeo.height + delta.height;
        newHeight = Math.max(minHeight, newHeight);
        if (panel.minHeight) newHeight = Math.max(panel.minHeight, newHeight);
        if (panel.maxHeight) newHeight = Math.min(panel.maxHeight, newHeight);
        newGeo.height = newHeight;
      }

      updateGeometry(panelId, {
        x: newGeo.x,
        y: newGeo.y,
        width: newGeo.width,
        height: newGeo.height,
      });

      // Update alignment offsets if resizing changes relevant dimensions
      // Update alignment offsets if resizing changes relevant dimensions
      if (panel.alignment) {
        const newAlignment = calculateNewAlignment(
          panel.alignment,
          {
            x: newGeo.x,
            y: newGeo.y,
            width: newGeo.width,
            height: newGeo.height,
          },
          delta,
          { width: window.innerWidth, height: window.innerHeight }
        );

        if (newAlignment) {
          updateAlignment(panelId, newAlignment);
        }
      }
    },
    [panel, panelId, updateGeometry, minWidth, minHeight, updateAlignment]
  );

  // 1. Hooks must run before return
  // 2. We can render null if panel is invalid/closed after hooks
  if (!panel || !panel.isOpen) return null;

  const isResizable = panel.resizable !== false;
  const isClosable = panel.closable !== false;
  const isMinimizable = panel.minimizable !== false;

  return (
    <div className={Style.floatingPanel} style={style} onPointerDown={handleFocus}>
      <div
        className={Style.panelHeader}
        onPointerDown={onTitleDown}
        onPointerMove={onTitleMove}
        onPointerUp={onTitleUp}
        onPointerLeave={onTitleLeave}
      >
        <span className={Style.panelTitle}>{title || panelId}</span>
        <div className={Style.windowControls}>
          {isMinimizable && (
            <button
              className={Style.iconBtn}
              onClick={(e) => {
                e.stopPropagation();
                minimizePanel(panelId);
              }}
              title={panel.isCollapsed ? 'Expand' : 'Collapse'}
            >
              {panel.isCollapsed ? <Maximize2 size={14} /> : <Minus size={14} />}
            </button>
          )}
          {isClosable && (
            <button
              className={Style.iconBtn}
              onClick={(e) => {
                e.stopPropagation();
                closePanel(panelId);
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {!panel.isCollapsed && (
        <>
          <div className={Style.panelContent}>{children}</div>
          {isResizable &&
            (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeDirection[]).map((dir) => (
              <ResizeHandle key={dir} dir={dir} onResize={handleResize} />
            ))}
        </>
      )}
    </div>
  );
});

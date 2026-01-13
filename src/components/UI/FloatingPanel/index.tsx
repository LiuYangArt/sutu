import Style from './FloatingPanel.module.css';
import { X, Minus, Maximize2 } from 'lucide-react';
import { usePanelStore } from '../../../stores/panel';
import type { PanelGeometry } from '../../../stores/panel';
import { usePanelDrag } from './usePanelDrag';
import { usePanelResize, ResizeDirection } from './usePanelResize';
import React, { useCallback } from 'react';

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

export function FloatingPanel({
  panelId,
  title,
  children,
  minWidth = 200,
  minHeight = 150,
}: FloatingPanelProps) {
  const panel = usePanelStore((s) => s.panels[panelId]);
  const updateGeometry = usePanelStore((s) => s.updateGeometry);
  const closePanel = usePanelStore((s) => s.closePanel);
  const minimizePanel = usePanelStore((s) => s.minimizePanel);
  const bringToFront = usePanelStore((s) => s.bringToFront);

  const handleFocus = useCallback(() => {
    bringToFront(panelId);
  }, [bringToFront, panelId]);

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

  const {
    onPointerDown: onTitleDown,
    onPointerMove: onTitleMove,
    onPointerUp: onTitleUp,
    onPointerLeave: onTitleLeave,
  } = usePanelDrag({
    onDrag: handleMove,
    onDragStart: handleFocus,
  });

  const handleResize = useCallback(
    (delta: Partial<PanelGeometry>) => {
      if (!panel) return;
      const newGeo = { ...panel };
      if (delta.x !== undefined) newGeo.x += delta.x;
      if (delta.y !== undefined) newGeo.y += delta.y;
      if (delta.width !== undefined) newGeo.width = Math.max(minWidth, newGeo.width + delta.width);
      if (delta.height !== undefined)
        newGeo.height = Math.max(minHeight, newGeo.height + delta.height);

      updateGeometry(panelId, {
        x: newGeo.x,
        y: newGeo.y,
        width: newGeo.width,
        height: newGeo.height,
      });
    },
    [panel, panelId, updateGeometry, minWidth, minHeight]
  );

  // 1. Hooks must run before return
  // 2. We can render null if panel is invalid/closed after hooks
  if (!panel || !panel.isOpen) return null;

  return (
    <div
      className={Style.floatingPanel}
      style={{
        left: panel.x,
        top: panel.y,
        width: panel.width,
        height: panel.isCollapsed ? 'auto' : panel.height,
        zIndex: panel.zIndex,
      }}
      onPointerDown={handleFocus}
    >
      <div
        className={Style.panelHeader}
        onPointerDown={onTitleDown}
        onPointerMove={onTitleMove}
        onPointerUp={onTitleUp}
        onPointerLeave={onTitleLeave}
      >
        <span className={Style.panelTitle}>{title || panelId}</span>
        <div className={Style.windowControls}>
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
          <button
            className={Style.iconBtn}
            onClick={(e) => {
              e.stopPropagation();
              closePanel(panelId);
            }}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {!panel.isCollapsed && (
        <>
          <div className={Style.panelContent}>{children}</div>
          {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeDirection[]).map((dir) => (
            <ResizeHandle key={dir} dir={dir} onResize={handleResize} />
          ))}
        </>
      )}
    </div>
  );
}

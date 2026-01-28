import { useCallback, useRef, useEffect, useState } from 'react';
import { useSelectionStore, SelectionPoint } from '@/stores/selection';
import { useDocumentStore } from '@/stores/document';
import { ToolType } from '@/stores/tool';

interface UseSelectionHandlerProps {
  currentTool: ToolType;
  scale: number;
}

interface SelectionHandlerResult {
  /** Handle pointer down for selection tools. Returns true if handled. */
  handleSelectionPointerDown: (
    canvasX: number,
    canvasY: number,
    e: PointerEvent | React.PointerEvent
  ) => boolean;

  /** Handle pointer move for selection tools */
  handleSelectionPointerMove: (
    canvasX: number,
    canvasY: number,
    e: PointerEvent | React.PointerEvent
  ) => void;

  /** Handle pointer up for selection tools */
  handleSelectionPointerUp: (canvasX: number, canvasY: number) => void;

  /** Handle double click for polygonal lasso completion */
  handleSelectionDoubleClick: (canvasX: number, canvasY: number) => void;

  /** Check if selection tool is active */
  isSelectionToolActive: boolean;

  /** Check if currently creating a selection */
  isCreatingSelection: boolean;

  /** Check if currently moving a selection */
  isMovingSelection: boolean;

  /** Current effective lasso mode (considering Alt key) */
  effectiveLassoMode: 'freehand' | 'polygonal';
}

/**
 * Hook to handle selection tool interactions (rect select + lasso)
 *
 * Lasso tool behavior (Photoshop-style):
 * - Default: freehand mode (drag to draw selection path)
 * - Hold Alt during selection: switch to polygonal mode (click to add vertices)
 * - Release Alt: return to freehand mode
 * - This allows mixing both modes in a single selection
 * - When Alt is pressed during freehand drawing, automatically anchor a point
 */
export function useSelectionHandler({
  currentTool,
}: UseSelectionHandlerProps): SelectionHandlerResult {
  const {
    isCreating,
    hasSelection,
    isMoving,
    beginSelection,
    addCreationPoint,
    updatePreviewPoint,
    updateCreationRect,
    commitSelection,
    isPointInSelection,
    beginMove,
    updateMove,
    commitMove,
    deselectAll,
    setSelectionMode,
    setLassoMode,
  } = useSelectionStore();

  const startPointRef = useRef<SelectionPoint | null>(null);
  const isSelectingRef = useRef(false);
  const lastPointRef = useRef<SelectionPoint | null>(null);
  // Track if actual dragging happened (for click-to-deselect logic)
  const hasDraggedRef = useRef(false);
  // Track if we started on existing selection (for click-to-deselect)
  const startedOnSelectionRef = useRef(false);

  // Track drag in polygonal mode to switch back to freehand
  const polygonalDragStartRef = useRef<SelectionPoint | null>(null);
  const DRAG_THRESHOLD = 5; // pixels

  // Track if mouse is currently pressed (for Alt release handling)
  const isMouseDownRef = useRef(false);

  // Track Alt key state for real-time mode switching during selection
  const [altPressed, setAltPressed] = useState(false);
  // Remove unused state to satisfy linter, logic uses refs

  // Track previous Alt state to detect transitions
  const prevAltRef = useRef(false);
  // Use ref for immediate Alt state access in event handlers (avoids React state async delay)
  const altPressedRef = useRef(false);
  const shiftPressedRef = useRef(false);
  const ctrlPressedRef = useRef(false);

  // Track if the current selection is purely polygonal (no freehand dragging)
  const isPurePolygonalRef = useRef(true);

  // Use ref to avoid stale closure in event handlers
  const currentToolRef = useRef(currentTool);
  currentToolRef.current = currentTool;

  // Listen for Alt key changes globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        const tool = currentToolRef.current;
        // When Alt is pressed during lasso selection, anchor current position
        if (
          tool === 'lasso' &&
          isSelectingRef.current &&
          lastPointRef.current &&
          !prevAltRef.current
        ) {
          // Anchoring a point when switching to polygonal mode
          addCreationPoint({ ...lastPointRef.current, type: 'polygonal' });
        }
        prevAltRef.current = true;
        altPressedRef.current = true;
        setAltPressed(true);
      }

      if (e.key === 'Shift') {
        shiftPressedRef.current = true;
      }

      if (e.key === 'Control') {
        ctrlPressedRef.current = true;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        const tool = currentToolRef.current;
        // When releasing Alt during lasso selection:
        if (tool === 'lasso' && isSelectingRef.current && prevAltRef.current) {
          const { width, height } = useDocumentStore.getState();

          // Determine final lasso mode based on interaction history
          setLassoMode(isPurePolygonalRef.current ? 'polygonal' : 'freehand');
          commitSelection(width, height);

          // Reset all selection state
          isSelectingRef.current = false;
          startPointRef.current = null;
          lastPointRef.current = null;
          hasDraggedRef.current = false;
          polygonalDragStartRef.current = null;
          isMouseDownRef.current = false;
        }

        prevAltRef.current = false;
        altPressedRef.current = false;
        setAltPressed(false);
      }

      if (e.key === 'Shift') {
        shiftPressedRef.current = false;
      }

      if (e.key === 'Control') {
        ctrlPressedRef.current = false;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [addCreationPoint, commitSelection, setLassoMode]);

  const isSelectionToolActive = currentTool === 'select' || currentTool === 'lasso';

  // Effective lasso mode: Alt pressed = polygonal, otherwise freehand
  const effectiveLassoMode = altPressed ? 'polygonal' : 'freehand';

  const handleSelectionPointerDown = useCallback(
    (canvasX: number, canvasY: number, e: PointerEvent | React.PointerEvent): boolean => {
      if (!isSelectionToolActive) return false;

      // Track mouse down state for Alt release handling
      isMouseDownRef.current = true;
      const isAltPressed = e.altKey;
      const point: SelectionPoint = {
        x: canvasX,
        y: canvasY,
        type: isAltPressed ? 'polygonal' : 'freehand',
      };

      // Reset drag tracking
      hasDraggedRef.current = false;
      startedOnSelectionRef.current = false;

      // Case 1: Continue existing polygonal lasso creation
      if (currentTool === 'lasso' && isAltPressed && isCreating) {
        lastPointRef.current = point;
        polygonalDragStartRef.current = point;
        return true;
      }

      // Case 3: Start New Selection (or Boolean Operation)
      // Check if starting new selection vs interacting with existing one (Move/Deselect)
      // ... logic simplified via guard clause below ...

      // Check shift/ctrl/boolean op
      const isShift = shiftPressedRef.current || e.shiftKey;
      const isCtrl = ctrlPressedRef.current || e.ctrlKey;
      const isBooleanOp = isShift || isCtrl;

      // Case 2: Handle interaction with existing selection (Move or Deselect)
      // Only applies if NOT performing a boolean operation (add/subtract)
      if (hasSelection && !isBooleanOp) {
        // Special case: Alt+Click with Lasso on existing selection starts new polygonal selection
        const isLassoPolygonalStart = currentTool === 'lasso' && isAltPressed;

        if (!isLassoPolygonalStart) {
          startedOnSelectionRef.current = true;

          if (isPointInSelection(canvasX, canvasY)) {
            // Clicked inside selection -> Start Move
            beginMove(point);
            return true;
          }

          // Clicked outside selection -> Deselect and Continue to Start New Selection
          deselectAll();
          startedOnSelectionRef.current = false;
        } else {
          // Lasso Polygonal Start -> Deselect and Continue
          deselectAll();
          startedOnSelectionRef.current = false;
        }
      }

      // Case 3: Start New Selection
      startPointRef.current = point;
      lastPointRef.current = point;
      isSelectingRef.current = true;

      // Initialize pure polygonal tracking for new selection
      // If valid start with Alt (polygonal mode), it's purely polygonal so far
      // If freehand start, it's NOT purely polygonal (unless just one point, but user will drag)
      isPurePolygonalRef.current = isAltPressed;

      // Determine selection mode
      let mode: 'new' | 'add' | 'subtract' | 'intersect' = 'new';
      if (isShift && isCtrl) mode = 'intersect';
      else if (isShift) mode = 'add';
      else if (isCtrl) mode = 'subtract';

      setSelectionMode(mode);
      beginSelection(point);

      return true;
    },
    [
      isSelectionToolActive,
      currentTool,
      isCreating,
      hasSelection,
      beginSelection,
      isPointInSelection,
      beginMove,
      deselectAll,
      setSelectionMode,
      setLassoMode,
    ]
  );

  const handleSelectionPointerMove = useCallback(
    (canvasX: number, canvasY: number, _e: PointerEvent | React.PointerEvent): void => {
      // Default type to freehand if not specified, but we'll override it below
      const point: SelectionPoint = { x: canvasX, y: canvasY, type: 'freehand' };

      // Handle move mode
      if (isMoving) {
        hasDraggedRef.current = true; // Mark that actual drag happened
        const { width, height } = useDocumentStore.getState();
        updateMove(point, width, height);
        return;
      }

      if (!isSelectingRef.current || !startPointRef.current) return;

      // Always update lastPointRef for tracking current mouse position
      lastPointRef.current = point;

      if (currentTool === 'select') {
        // Rectangular selection: update rect from start to current
        updateCreationRect(startPointRef.current, point);
      } else if (currentTool === 'lasso') {
        // Lasso tool: mode depends on Alt key state
        // Use ref for immediate access (React state updates are async)
        const isAltMode = altPressedRef.current;
        if (isAltMode) {
          // Polygonal mode behavior
          if (isMouseDownRef.current) {
            // Mouse is pressed - detect drag to switch back to freehand
            if (!polygonalDragStartRef.current) {
              polygonalDragStartRef.current = point;
            } else {
              const dx = point.x - polygonalDragStartRef.current.x;
              const dy = point.y - polygonalDragStartRef.current.y;
              const distance = Math.sqrt(dx * dx + dy * dy);

              if (distance > DRAG_THRESHOLD) {
                // Switch to freehand: add anchor point and start drawing
                if (polygonalDragStartRef.current) {
                  addCreationPoint({ ...polygonalDragStartRef.current, type: 'polygonal' });
                }
                addCreationPoint({ ...point, type: 'freehand' });
                polygonalDragStartRef.current = null;

                // User dragged, so it's no longer purely polygonal
                isPurePolygonalRef.current = false;
              }
            }
          } else {
            // Mouse is not pressed - update preview line to follow cursor
            updatePreviewPoint(point);
            polygonalDragStartRef.current = null; // Reset drag tracking
          }
        } else {
          // Freehand mode: accumulate points continuously
          polygonalDragStartRef.current = null; // Reset drag tracking
          updatePreviewPoint(null); // Clear preview point
          addCreationPoint({ ...point, type: 'freehand' });

          // User is freehand drawing, so it's not purely polygonal
          isPurePolygonalRef.current = false;
        }
      }
    },
    [currentTool, isMoving, updateMove, updateCreationRect, addCreationPoint, updatePreviewPoint]
  );

  const handleSelectionPointerUp = useCallback(
    (canvasX: number, canvasY: number): void => {
      // Always reset mouse down state
      isMouseDownRef.current = false;

      // Handle move mode completion
      if (isMoving) {
        const { width, height } = useDocumentStore.getState();
        // If no actual drag happened, it's a click - deselect
        if (!hasDraggedRef.current) {
          deselectAll();
        } else {
          commitMove(width, height);
        }
        hasDraggedRef.current = false;
        startedOnSelectionRef.current = false;
        return;
      }

      // Click on existing selection without drag = deselect
      if (startedOnSelectionRef.current && !hasDraggedRef.current) {
        deselectAll();
        hasDraggedRef.current = false;
        startedOnSelectionRef.current = false;
        return;
      }

      if (!isSelectingRef.current) return;

      const point: SelectionPoint = { x: canvasX, y: canvasY, type: 'freehand' };

      // For lasso tool in polygonal mode (Alt pressed), don't commit yet
      // User needs to release Alt to finish (handled in handleKeyUp)
      if (currentTool === 'lasso' && altPressed) {
        // Add the point as a vertex
        addCreationPoint({ ...point, type: 'polygonal' });
        lastPointRef.current = point;
        polygonalDragStartRef.current = null; // Reset for next click
        // Keep isSelectingRef true so user can continue
        return;
      }

      // Commit selection for rect select and freehand lasso
      const { width, height } = useDocumentStore.getState();

      // Update lasso mode based on usage history
      setLassoMode(isPurePolygonalRef.current ? 'polygonal' : 'freehand');
      commitSelection(width, height);

      isSelectingRef.current = false;
      startPointRef.current = null;
      lastPointRef.current = null;
      polygonalDragStartRef.current = null;
      hasDraggedRef.current = false;
      startedOnSelectionRef.current = false;
    },
    [
      currentTool,
      altPressed,
      isMoving,
      addCreationPoint,
      commitSelection,
      commitMove,
      deselectAll,
      setLassoMode,
    ]
  );

  const handleSelectionDoubleClick = useCallback(
    (_canvasX: number, _canvasY: number): void => {
      // Double-click completes lasso selection (works in both modes)
      if (currentTool === 'lasso' && isCreating) {
        const { width, height } = useDocumentStore.getState();
        setLassoMode(isPurePolygonalRef.current ? 'polygonal' : 'freehand');
        commitSelection(width, height);
        isSelectingRef.current = false;
        startPointRef.current = null;
        lastPointRef.current = null;
      }
    },
    [currentTool, isCreating, commitSelection, setLassoMode]
  );

  return {
    handleSelectionPointerDown,
    handleSelectionPointerMove,
    handleSelectionPointerUp,
    handleSelectionDoubleClick,
    isSelectionToolActive,
    isCreatingSelection: isCreating,
    isMovingSelection: isMoving,
    effectiveLassoMode,
  };
}

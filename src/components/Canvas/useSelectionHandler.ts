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
    isPointInBounds,
    beginMove,
    updateMove,
    commitMove,
    deselectAll,
    setSelectionMode,
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
          addCreationPoint(lastPointRef.current);
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
  }, [addCreationPoint, commitSelection]);

  const isSelectionToolActive = currentTool === 'select' || currentTool === 'lasso';

  // Effective lasso mode: Alt pressed = polygonal, otherwise freehand
  const effectiveLassoMode = altPressed ? 'polygonal' : 'freehand';

  const handleSelectionPointerDown = useCallback(
    (canvasX: number, canvasY: number, e: PointerEvent | React.PointerEvent): boolean => {
      if (!isSelectionToolActive) return false;

      // Track mouse down state for Alt release handling
      isMouseDownRef.current = true;

      const point: SelectionPoint = { x: canvasX, y: canvasY };
      const isAltPressed = e.altKey;

      // Reset drag tracking
      hasDraggedRef.current = false;
      startedOnSelectionRef.current = false;

      // For lasso tool in polygonal mode (Alt held) while already creating
      // Don't add point here - will be added in pointerUp to avoid duplicates
      if (currentTool === 'lasso' && isAltPressed && isCreating) {
        lastPointRef.current = point;
        polygonalDragStartRef.current = point; // Start tracking potential drag
        return true;
      }

      // Use tracked refs for robustness
      const isShift = shiftPressedRef.current || e.shiftKey;
      const isCtrl = ctrlPressedRef.current || e.ctrlKey;
      const isBooleanOp = isShift || isCtrl;

      // Check if clicking on existing selection (for move or click-to-deselect)
      // If performing boolean op, skip move/deselect logic entirely
      if (hasSelection && !isBooleanOp) {
        // Requirement 2: Alt+Click on existing selection should start new polygonal selection
        // Only if NOT a boolean op (Shift+Alt = Add Polygonal)
        if (currentTool === 'lasso' && isAltPressed) {
          deselectAll();
          startedOnSelectionRef.current = false;
          // Fall through to start new selection below
        } else {
          startedOnSelectionRef.current = true;
          if (isPointInBounds(canvasX, canvasY)) {
            // Start potential move (will be confirmed if drag happens)
            beginMove(point);
            return true;
          }
          // Clicking outside bounds - deselect and start new selection
          deselectAll();
          startedOnSelectionRef.current = false;
          // Fall through to start new selection
        }
      }

      // Start new selection
      startPointRef.current = point;
      lastPointRef.current = point;
      isSelectingRef.current = true;
      // Determine mode based on modifiers
      // User Req: Shift = Add, Ctrl = Subtract

      let mode: 'new' | 'add' | 'subtract' | 'intersect' = 'new';
      if (isShift && isCtrl) {
        mode = 'intersect';
      } else if (isShift) {
        mode = 'add';
      } else if (isCtrl) {
        mode = 'subtract';
      }

      setSelectionMode(mode);

      startPointRef.current = point;
      lastPointRef.current = point;
      isSelectingRef.current = true;
      beginSelection(point);

      return true;
    },
    [
      isSelectionToolActive,
      currentTool,
      isCreating,
      hasSelection,
      beginSelection,
      isPointInBounds,
      beginMove,
      deselectAll,
      setSelectionMode,
    ]
  );

  const handleSelectionPointerMove = useCallback(
    (canvasX: number, canvasY: number, _e: PointerEvent | React.PointerEvent): void => {
      const point: SelectionPoint = { x: canvasX, y: canvasY };

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
          // Polygonal mode behavior:
          // 1. If mouse is DOWN (dragging), check if we should switch back to freehand
          // 2. If mouse is UP (just moving), update preview line to follow cursor
          if (isMouseDownRef.current) {
            // Mouse is pressed - detect drag to switch back to freehand
            if (!polygonalDragStartRef.current) {
              // Record drag start position
              polygonalDragStartRef.current = point;
            } else {
              // Check if drag exceeds threshold
              const dx = point.x - polygonalDragStartRef.current.x;
              const dy = point.y - polygonalDragStartRef.current.y;
              const distance = Math.sqrt(dx * dx + dy * dy);

              if (distance > DRAG_THRESHOLD) {
                // Switch to freehand: add anchor point and start drawing
                addCreationPoint(polygonalDragStartRef.current);
                addCreationPoint(point);
                polygonalDragStartRef.current = null;
                // Note: altPressedRef is still true, but we're now in "freehand within polygonal" mode
                // This allows mixed freehand+polygonal paths
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
          addCreationPoint(point);
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

      const point: SelectionPoint = { x: canvasX, y: canvasY };

      // For lasso tool in polygonal mode (Alt pressed), don't commit yet
      // User needs to release Alt to finish (handled in handleKeyUp)
      if (currentTool === 'lasso' && altPressed) {
        // Add the point as a vertex
        addCreationPoint(point);
        lastPointRef.current = point;
        polygonalDragStartRef.current = null; // Reset for next click
        // Keep isSelectingRef true so user can continue
        return;
      }

      // Commit selection for rect select and freehand lasso
      const { width, height } = useDocumentStore.getState();
      commitSelection(width, height);

      isSelectingRef.current = false;
      startPointRef.current = null;
      lastPointRef.current = null;
      polygonalDragStartRef.current = null;
      hasDraggedRef.current = false;
      startedOnSelectionRef.current = false;
    },
    [currentTool, altPressed, isMoving, addCreationPoint, commitSelection, commitMove, deselectAll]
  );

  const handleSelectionDoubleClick = useCallback(
    (_canvasX: number, _canvasY: number): void => {
      // Double-click completes lasso selection (works in both modes)
      if (currentTool === 'lasso' && isCreating) {
        const { width, height } = useDocumentStore.getState();
        commitSelection(width, height);
        isSelectingRef.current = false;
        startPointRef.current = null;
        lastPointRef.current = null;
      }
    },
    [currentTool, isCreating, commitSelection]
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

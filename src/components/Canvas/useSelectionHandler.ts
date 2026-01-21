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
  const { isCreating, beginSelection, addCreationPoint, updateCreationRect, commitSelection } =
    useSelectionStore();

  const startPointRef = useRef<SelectionPoint | null>(null);
  const isSelectingRef = useRef(false);
  const lastPointRef = useRef<SelectionPoint | null>(null);

  // Track Alt key state for real-time mode switching during selection
  const [altPressed, setAltPressed] = useState(false);
  // Track previous Alt state to detect transitions
  const prevAltRef = useRef(false);

  // Listen for Alt key changes globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        // When Alt is pressed during lasso selection, anchor current position
        if (
          currentTool === 'lasso' &&
          isSelectingRef.current &&
          lastPointRef.current &&
          !prevAltRef.current
        ) {
          // Add current mouse position as anchor point when entering polygonal mode
          addCreationPoint(lastPointRef.current);
        }
        prevAltRef.current = true;
        setAltPressed(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        prevAltRef.current = false;
        setAltPressed(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [currentTool, addCreationPoint]);

  const isSelectionToolActive = currentTool === 'select' || currentTool === 'lasso';

  // Effective lasso mode: Alt pressed = polygonal, otherwise freehand
  const effectiveLassoMode = altPressed ? 'polygonal' : 'freehand';

  const handleSelectionPointerDown = useCallback(
    (canvasX: number, canvasY: number, e: PointerEvent | React.PointerEvent): boolean => {
      if (!isSelectionToolActive) return false;

      const point: SelectionPoint = { x: canvasX, y: canvasY };
      const isAltPressed = e.altKey;

      // For lasso tool in polygonal mode (Alt held) while already creating, just add a vertex
      if (currentTool === 'lasso' && isAltPressed && isCreating) {
        addCreationPoint(point);
        lastPointRef.current = point;
        return true;
      }

      // Start new selection
      startPointRef.current = point;
      lastPointRef.current = point;
      isSelectingRef.current = true;
      beginSelection(point);

      return true;
    },
    [isSelectionToolActive, currentTool, isCreating, beginSelection, addCreationPoint]
  );

  const handleSelectionPointerMove = useCallback(
    (canvasX: number, canvasY: number, e: PointerEvent | React.PointerEvent) => {
      if (!isSelectingRef.current || !startPointRef.current) return;

      const point: SelectionPoint = { x: canvasX, y: canvasY };
      const isAltPressed = e.altKey;

      // Always update lastPointRef for tracking current mouse position
      lastPointRef.current = point;

      if (currentTool === 'select') {
        // Rectangular selection: update rect from start to current
        updateCreationRect(startPointRef.current, point);
      } else if (currentTool === 'lasso') {
        // Lasso tool: mode depends on Alt key state
        if (isAltPressed) {
          // Polygonal mode (Alt held): don't add points during move
          // Points are added on click or when Alt is first pressed
        } else {
          // Freehand mode: accumulate points continuously
          addCreationPoint(point);
        }
      }
    },
    [currentTool, updateCreationRect, addCreationPoint]
  );

  const handleSelectionPointerUp = useCallback(
    (canvasX: number, canvasY: number) => {
      if (!isSelectingRef.current) return;

      const point: SelectionPoint = { x: canvasX, y: canvasY };

      // For lasso tool in polygonal mode (Alt pressed), don't commit yet
      // User needs to release Alt and continue or double-click to finish
      if (currentTool === 'lasso' && altPressed) {
        // Add the point as a vertex
        addCreationPoint(point);
        lastPointRef.current = point;
        // Keep isSelectingRef true so user can continue in freehand when Alt released
        return;
      }

      // Commit selection for rect select and freehand lasso
      const { width, height } = useDocumentStore.getState();
      commitSelection(width, height);

      isSelectingRef.current = false;
      startPointRef.current = null;
      lastPointRef.current = null;
    },
    [currentTool, altPressed, addCreationPoint, commitSelection]
  );

  const handleSelectionDoubleClick = useCallback(
    (_canvasX: number, _canvasY: number) => {
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
    effectiveLassoMode,
  };
}

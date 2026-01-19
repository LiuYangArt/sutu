/**
 * Canvas command utilities - centralized window interface calls
 */

type CanvasWindow = Window & {
  __canvasClearLayer?: () => void;
  __canvasUndo?: () => void;
  __canvasRedo?: () => void;
  __canvasFillLayer?: (color: string) => void;
  __canvasRemoveLayer?: (id: string) => void;
  __canvasDuplicateLayer?: (from: string, to: string) => void;
};

const getWin = (): CanvasWindow => window as CanvasWindow;

/** Clear the active layer content */
export const clearActiveLayer = () => getWin().__canvasClearLayer?.();

/** Undo last action */
export const undo = () => getWin().__canvasUndo?.();

/** Redo last undone action */
export const redo = () => getWin().__canvasRedo?.();

/** Fill active layer with color */
export const fillLayer = (color: string) => getWin().__canvasFillLayer?.(color);

/** Remove a layer by ID */
export const removeLayer = (id: string) => getWin().__canvasRemoveLayer?.(id);

/** Duplicate a layer */
export const duplicateLayer = (fromId: string, toId: string) =>
  getWin().__canvasDuplicateLayer?.(fromId, toId);

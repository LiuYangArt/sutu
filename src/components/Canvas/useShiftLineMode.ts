import { useCallback, useEffect, useRef } from 'react';

type Point = { x: number; y: number };

interface UseShiftLineModeOptions {
  enabled: boolean;
  onInvalidate?: () => void;
}

interface GuideLine {
  start: Point;
  end: Point;
}

interface UseShiftLineModeResult {
  getAnchorPoint: () => Point | null;
  isLineMode: () => boolean;
  isLineLocked: () => boolean;
  isSnapMode: () => boolean;
  getGuideLine: () => GuideLine | null;
  updateCursor: (x: number, y: number) => void;
  constrainPoint: (x: number, y: number) => Point;
  onStrokeEnd: (lastDabPos?: Point | null) => void;
  lockLine: (endPoint: Point) => void;
  unlockLine: () => void;
}

const SNAP_ANGLE = Math.PI / 4;

function snapEndPoint(start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return { ...end };
  }
  const angle = Math.atan2(dy, dx);
  const snapped = Math.round(angle / SNAP_ANGLE) * SNAP_ANGLE;
  return {
    x: start.x + Math.cos(snapped) * length,
    y: start.y + Math.sin(snapped) * length,
  };
}

function projectPointToSegment(point: Point, start: Point, end: Point): Point {
  const abx = end.x - start.x;
  const aby = end.y - start.y;
  const abLenSq = abx * abx + aby * aby;
  if (abLenSq === 0) {
    return { ...start };
  }
  const apx = point.x - start.x;
  const apy = point.y - start.y;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
  return {
    x: start.x + abx * t,
    y: start.y + aby * t,
  };
}

export function useShiftLineMode({
  enabled,
  onInvalidate,
}: UseShiftLineModeOptions): UseShiftLineModeResult {
  const anchorRef = useRef<Point | null>(null);
  const tempAnchorRef = useRef<Point | null>(null);
  const cursorRef = useRef<Point | null>(null);
  const lockedEndRef = useRef<Point | null>(null);
  const isLockedRef = useRef(false);
  const shiftPressedRef = useRef(false);
  const ctrlPressedRef = useRef(false);
  const enabledRef = useRef(enabled);
  const invalidateRef = useRef(onInvalidate);

  const clearLockedLine = useCallback(function clearLockedLine(): void {
    isLockedRef.current = false;
    lockedEndRef.current = null;
  }, []);

  const clearTempAnchor = useCallback(function clearTempAnchor(): void {
    tempAnchorRef.current = null;
  }, []);

  const ensureTempAnchorFromCursor = useCallback(function ensureTempAnchorFromCursor(): void {
    if (!anchorRef.current && !tempAnchorRef.current && cursorRef.current) {
      tempAnchorRef.current = { ...cursorRef.current };
    }
  }, []);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      if (isLockedRef.current || tempAnchorRef.current) {
        clearLockedLine();
        clearTempAnchor();
      }
      invalidateRef.current?.();
      return;
    }

    if (shiftPressedRef.current && (anchorRef.current || tempAnchorRef.current)) {
      invalidateRef.current?.();
    }
  }, [enabled, clearLockedLine, clearTempAnchor]);

  useEffect(() => {
    invalidateRef.current = onInvalidate;
  }, [onInvalidate]);

  const setShiftPressed = useCallback(
    (pressed: boolean) => {
      if (shiftPressedRef.current === pressed) return;
      shiftPressedRef.current = pressed;

      if (!pressed) {
        if (isLockedRef.current) {
          clearLockedLine();
        }
        clearTempAnchor();
        invalidateRef.current?.();
        return;
      }

      ensureTempAnchorFromCursor();
      invalidateRef.current?.();
    },
    [clearLockedLine, clearTempAnchor, ensureTempAnchorFromCursor]
  );

  const setCtrlPressed = useCallback((pressed: boolean) => {
    if (ctrlPressedRef.current === pressed) return;
    ctrlPressedRef.current = pressed;
    if (!isLockedRef.current) {
      invalidateRef.current?.();
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === 'Shift') setShiftPressed(true);
      if (e.key === 'Control') setCtrlPressed(true);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftPressed(false);
      if (e.key === 'Control') setCtrlPressed(false);
    };

    const handleBlur = () => {
      setShiftPressed(false);
      setCtrlPressed(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [setShiftPressed, setCtrlPressed]);

  const isLineMode = useCallback(() => {
    return (
      enabledRef.current &&
      shiftPressedRef.current &&
      Boolean(anchorRef.current || tempAnchorRef.current)
    );
  }, []);

  const isSnapMode = useCallback(() => {
    return enabledRef.current && shiftPressedRef.current && ctrlPressedRef.current;
  }, []);

  const isLineLocked = useCallback(() => {
    return isLockedRef.current;
  }, []);

  const updateCursor = useCallback((x: number, y: number) => {
    cursorRef.current = { x, y };

    if (!enabledRef.current || !shiftPressedRef.current) return;

    if (!anchorRef.current && !tempAnchorRef.current) {
      tempAnchorRef.current = { x, y };
      invalidateRef.current?.();
      return;
    }

    if (!isLockedRef.current) {
      invalidateRef.current?.();
    }
  }, []);

  const getGuideLine = useCallback((): GuideLine | null => {
    if (!isLineMode()) return null;
    const start = anchorRef.current ?? tempAnchorRef.current;
    if (!start) return null;

    if (isLockedRef.current) {
      const end = lockedEndRef.current;
      if (!end) return null;
      return { start, end };
    }

    const cursor = cursorRef.current;
    if (!cursor) return null;
    const end = ctrlPressedRef.current ? snapEndPoint(start, cursor) : cursor;
    return { start, end };
  }, [isLineMode]);

  const lockLine = useCallback((endPoint: Point) => {
    if (!enabledRef.current || !shiftPressedRef.current) return;
    if (isLockedRef.current) return;

    if (!anchorRef.current && !tempAnchorRef.current) {
      tempAnchorRef.current = { ...endPoint };
    }

    const start = anchorRef.current ?? tempAnchorRef.current ?? endPoint;
    const lockedEnd = ctrlPressedRef.current ? snapEndPoint(start, endPoint) : endPoint;
    lockedEndRef.current = lockedEnd;
    isLockedRef.current = true;
    invalidateRef.current?.();
  }, []);

  const unlockLine = useCallback(() => {
    if (!isLockedRef.current) return;
    clearLockedLine();
    invalidateRef.current?.();
  }, [clearLockedLine]);

  const constrainPoint = useCallback((x: number, y: number): Point => {
    if (!enabledRef.current || !isLockedRef.current) {
      return { x, y };
    }
    const start = anchorRef.current ?? tempAnchorRef.current;
    const end = lockedEndRef.current;
    if (!start || !end) {
      return { x, y };
    }
    return projectPointToSegment({ x, y }, start, end);
  }, []);

  const onStrokeEnd = useCallback(
    (lastDabPos?: Point | null) => {
      if (lastDabPos) {
        anchorRef.current = { ...lastDabPos };
      }
      clearLockedLine();
      clearTempAnchor();

      if (shiftPressedRef.current && !anchorRef.current) {
        ensureTempAnchorFromCursor();
      }

      invalidateRef.current?.();
    },
    [clearLockedLine, clearTempAnchor, ensureTempAnchorFromCursor]
  );

  const getAnchorPoint = useCallback(() => anchorRef.current, []);

  return {
    getAnchorPoint,
    isLineMode,
    isLineLocked,
    isSnapMode,
    getGuideLine,
    updateCursor,
    constrainPoint,
    onStrokeEnd,
    lockLine,
    unlockLine,
  };
}

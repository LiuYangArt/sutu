import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePanelStore } from '@/stores/panel';
import type {
  CurvePoint,
  CurvesChannel,
  CurvesPointsByChannel,
  CurvesPreviewPayload,
  CurvesSessionInfo,
} from '@/types/curves';
import { buildCurveLut } from '@/utils/curvesRenderer';
import './CurvesPanel.css';

const GRAPH_SIZE = 256;
const POINT_HIT_RADIUS_PX = 8;
const GRID_DIVISIONS = 4;

type CurvesBridgeWindow = Window & {
  __canvasCurvesBeginSession?: () => CurvesSessionInfo | null;
  __canvasCurvesPreview?: (sessionId: string, payload: CurvesPreviewPayload) => boolean;
  __canvasCurvesCommit?: (sessionId: string, payload: CurvesPreviewPayload) => Promise<boolean>;
  __canvasCurvesCancel?: (sessionId: string) => void;
};

interface DragState {
  channel: CurvesChannel;
  pointId: string;
  beforeSnapshot: CurvesPanelSnapshot | null;
  moved: boolean;
}

interface CurvesPanelSnapshot {
  selectedChannel: CurvesChannel;
  previewEnabled: boolean;
  selectedPointId: string | null;
  pointsByChannel: CurvesPointsByChannel;
}

const CHANNEL_OPTIONS: Array<{ value: CurvesChannel; label: string }> = [
  { value: 'rgb', label: 'RGB' },
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
];

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

function createDefaultPoints(nextId: () => string): CurvesPointsByChannel {
  const createChannel = (): CurvePoint[] => [
    { id: nextId(), x: 0, y: 0 },
    { id: nextId(), x: 255, y: 255 },
  ];
  return {
    rgb: createChannel(),
    red: createChannel(),
    green: createChannel(),
    blue: createChannel(),
  };
}

function clonePointsByChannel(pointsByChannel: CurvesPointsByChannel): CurvesPointsByChannel {
  const cloneChannel = (points: CurvePoint[]): CurvePoint[] =>
    points.map((point) => ({ id: point.id, x: point.x, y: point.y }));
  return {
    rgb: cloneChannel(pointsByChannel.rgb),
    red: cloneChannel(pointsByChannel.red),
    green: cloneChannel(pointsByChannel.green),
    blue: cloneChannel(pointsByChannel.blue),
  };
}

function toGraphX(input: number): number {
  return (clamp(input, 0, 255) / 255) * GRAPH_SIZE;
}

function toGraphY(output: number): number {
  return GRAPH_SIZE - (clamp(output, 0, 255) / 255) * GRAPH_SIZE;
}

function fromGraphPoint(clientX: number, clientY: number, rect: DOMRect): { x: number; y: number } {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const safeClientX = Number.isFinite(clientX) ? clientX : rect.left;
  const safeClientY = Number.isFinite(clientY) ? clientY : rect.top;
  const localX = clamp(safeClientX - rect.left, 0, width);
  const localY = clamp(safeClientY - rect.top, 0, height);
  const x = Math.round((localX / width) * 255);
  const y = Math.round(255 - (localY / height) * 255);
  return { x: clamp(x, 0, 255), y: clamp(y, 0, 255) };
}

function getSelectedPoint(points: CurvePoint[], selectedId: string | null): CurvePoint | null {
  if (!selectedId) return null;
  return points.find((point) => point.id === selectedId) ?? null;
}

function buildPathFromLut(lut: Uint8Array): string {
  let path = '';
  for (let i = 0; i < lut.length; i += 1) {
    const value = lut[i] ?? i;
    const x = toGraphX(i);
    const y = toGraphY(value);
    path += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
  }
  return path;
}

export function CurvesPanel(): JSX.Element {
  const closePanel = usePanelStore((s) => s.closePanel);
  const pointIdRef = useRef(0);
  const graphRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const previewRafRef = useRef<number | null>(null);
  const latestPayloadRef = useRef<CurvesPreviewPayload | null>(null);
  const committedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const undoStackRef = useRef<CurvesPanelSnapshot[]>([]);
  const redoStackRef = useRef<CurvesPanelSnapshot[]>([]);
  const currentSnapshotRef = useRef<CurvesPanelSnapshot>({
    selectedChannel: 'rgb',
    previewEnabled: true,
    selectedPointId: null,
    pointsByChannel: {
      rgb: [],
      red: [],
      green: [],
      blue: [],
    },
  });

  const getNextPointId = useCallback(() => {
    pointIdRef.current += 1;
    return `curves-point-${pointIdRef.current}`;
  }, []);

  const [selectedChannel, setSelectedChannel] = useState<CurvesChannel>('rgb');
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [pointsByChannel, setPointsByChannel] = useState<CurvesPointsByChannel>(() =>
    createDefaultPoints(() => `curves-point-${++pointIdRef.current}`)
  );
  const [sessionInfo, setSessionInfo] = useState<CurvesSessionInfo | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);

  const activePoints = pointsByChannel[selectedChannel];
  const selectedPoint = getSelectedPoint(activePoints, selectedPointId);
  const canUndo = historyVersion >= 0 && undoStackRef.current.length > 0;
  const canRedo = historyVersion >= 0 && redoStackRef.current.length > 0;

  const luts = useMemo(() => {
    return {
      rgb: buildCurveLut(pointsByChannel.rgb),
      red: buildCurveLut(pointsByChannel.red),
      green: buildCurveLut(pointsByChannel.green),
      blue: buildCurveLut(pointsByChannel.blue),
    };
  }, [pointsByChannel]);

  const histogram = sessionInfo?.histogram ?? [];
  const histogramMax = histogram.reduce((max, value) => Math.max(max, value), 0);

  const curvesPayload = useMemo<CurvesPreviewPayload>(
    () => ({
      previewEnabled,
      rgbLut: Array.from(luts.rgb),
      redLut: Array.from(luts.red),
      greenLut: Array.from(luts.green),
      blueLut: Array.from(luts.blue),
    }),
    [luts.blue, luts.green, luts.red, luts.rgb, previewEnabled]
  );

  const captureSnapshot = useCallback((): CurvesPanelSnapshot => {
    const current = currentSnapshotRef.current;
    return {
      selectedChannel: current.selectedChannel,
      previewEnabled: current.previewEnabled,
      selectedPointId: current.selectedPointId,
      pointsByChannel: clonePointsByChannel(current.pointsByChannel),
    };
  }, []);

  const applySnapshot = useCallback((snapshot: CurvesPanelSnapshot) => {
    setSelectedChannel(snapshot.selectedChannel);
    setPreviewEnabled(snapshot.previewEnabled);
    setSelectedPointId(snapshot.selectedPointId);
    setPointsByChannel(clonePointsByChannel(snapshot.pointsByChannel));
  }, []);

  const pushUndoSnapshot = useCallback((snapshot: CurvesPanelSnapshot) => {
    undoStackRef.current.push(snapshot);
    if (undoStackRef.current.length > 200) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
    setHistoryVersion((value) => value + 1);
  }, []);

  const handleLocalUndo = useCallback(() => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current.push(captureSnapshot());
    applySnapshot(previous);
    setHistoryVersion((value) => value + 1);
  }, [applySnapshot, captureSnapshot]);

  const handleLocalRedo = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(captureSnapshot());
    applySnapshot(next);
    setHistoryVersion((value) => value + 1);
  }, [applySnapshot, captureSnapshot]);

  const requestPreviewFrame = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    if (previewRafRef.current !== null) return;
    previewRafRef.current = window.requestAnimationFrame(() => {
      previewRafRef.current = null;
      const latestPayload = latestPayloadRef.current;
      if (!latestPayload) return;
      const win = window as CurvesBridgeWindow;
      win.__canvasCurvesPreview?.(sessionId, latestPayload);
    });
  }, []);

  const stopPreviewFrame = useCallback(() => {
    if (previewRafRef.current !== null) {
      window.cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = null;
    }
  }, []);

  const endSession = useCallback(
    (shouldCancel: boolean) => {
      stopPreviewFrame();
      const win = window as CurvesBridgeWindow;
      const sessionId = sessionIdRef.current;
      if (shouldCancel && sessionId) {
        win.__canvasCurvesCancel?.(sessionId);
      }
      sessionIdRef.current = null;
      latestPayloadRef.current = null;
      setSessionInfo(null);
    },
    [stopPreviewFrame]
  );

  useEffect(() => {
    const win = window as CurvesBridgeWindow;
    const info = win.__canvasCurvesBeginSession?.() ?? null;
    if (!info) {
      setErrorText('当前图层不可调整（图层锁定、不可见或选区尚未就绪）。');
      return;
    }
    sessionIdRef.current = info.sessionId;
    setSessionInfo(info);
    setErrorText(null);
    return () => {
      const shouldCancel = !committedRef.current;
      endSession(shouldCancel);
    };
  }, [endSession]);

  useEffect(() => {
    currentSnapshotRef.current = {
      selectedChannel,
      previewEnabled,
      selectedPointId,
      pointsByChannel: clonePointsByChannel(pointsByChannel),
    };
  }, [pointsByChannel, previewEnabled, selectedChannel, selectedPointId]);

  useEffect(() => {
    latestPayloadRef.current = curvesPayload;
    requestPreviewFrame();
  }, [curvesPayload, requestPreviewFrame]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      const graph = graphRef.current;
      if (!drag || !graph) return;
      const rect = graph.getBoundingClientRect();
      const point = fromGraphPoint(event.clientX, event.clientY, rect);
      let didMove = false;
      setPointsByChannel((prev) => {
        const channelPoints = prev[drag.channel];
        const index = channelPoints.findIndex((item) => item.id === drag.pointId);
        if (index < 0) return prev;
        const nextPoints = [...channelPoints];
        const current = nextPoints[index];
        if (!current) return prev;

        let nextX = point.x;
        const isFirst = index === 0;
        const isLast = index === channelPoints.length - 1;
        if (isFirst) {
          nextX = 0;
        } else if (isLast) {
          nextX = 255;
        } else {
          const prevPoint = channelPoints[index - 1];
          const nextPoint = channelPoints[index + 1];
          const minX = (prevPoint?.x ?? 0) + 1;
          const maxX = (nextPoint?.x ?? 255) - 1;
          nextX = clamp(nextX, minX, maxX);
        }

        if (current.x === nextX && current.y === point.y) {
          return prev;
        }
        didMove = true;
        nextPoints[index] = {
          ...current,
          x: clamp(nextX, 0, 255),
          y: clamp(point.y, 0, 255),
        };
        return {
          ...prev,
          [drag.channel]: nextPoints,
        };
      });
      if (didMove && dragRef.current) {
        dragRef.current.moved = true;
      }
    };

    const onPointerUp = (): void => {
      const drag = dragRef.current;
      if (drag?.moved && drag.beforeSnapshot) {
        pushUndoSnapshot(drag.beforeSnapshot);
      }
      dragRef.current = null;
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [pushUndoSnapshot]);

  useEffect(() => {
    const handlePanelKeyDown = (event: KeyboardEvent): void => {
      const modifierPressed = event.ctrlKey || event.metaKey;
      if (modifierPressed && !event.altKey) {
        if (event.code === 'KeyZ') {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) {
            handleLocalRedo();
          } else {
            handleLocalUndo();
          }
          return;
        }
        if (event.code === 'KeyY') {
          event.preventDefault();
          event.stopPropagation();
          handleLocalRedo();
          return;
        }
      }

      if (event.key !== 'Delete') return;
      if (isEditableTarget(event.target)) return;
      const points = pointsByChannel[selectedChannel];
      const index = points.findIndex((point) => point.id === selectedPointId);
      if (index <= 0 || index >= points.length - 1) return;
      event.preventDefault();
      event.stopPropagation();
      pushUndoSnapshot(captureSnapshot());
      setPointsByChannel((prev) => {
        const channelPoints = prev[selectedChannel];
        const removeIndex = channelPoints.findIndex((point) => point.id === selectedPointId);
        if (removeIndex <= 0 || removeIndex >= channelPoints.length - 1) return prev;
        const nextPoints = channelPoints.filter((point) => point.id !== selectedPointId);
        return {
          ...prev,
          [selectedChannel]: nextPoints,
        };
      });
      setSelectedPointId(null);
    };

    window.addEventListener('keydown', handlePanelKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handlePanelKeyDown, true);
    };
  }, [
    captureSnapshot,
    handleLocalRedo,
    handleLocalUndo,
    pointsByChannel,
    pushUndoSnapshot,
    selectedChannel,
    selectedPointId,
  ]);

  const handleGraphPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const graph = graphRef.current;
      if (!graph) return;
      const rect = graph.getBoundingClientRect();
      const point = fromGraphPoint(event.clientX, event.clientY, rect);
      const channelPoints = pointsByChannel[selectedChannel];

      let hitPointId: string | null = null;
      for (const curvePoint of channelPoints) {
        const dx = toGraphX(curvePoint.x) - (event.clientX - rect.left);
        const dy = toGraphY(curvePoint.y) - (event.clientY - rect.top);
        if (Math.hypot(dx, dy) <= POINT_HIT_RADIUS_PX) {
          hitPointId = curvePoint.id;
          break;
        }
      }

      if (hitPointId) {
        setSelectedPointId(hitPointId);
        dragRef.current = {
          channel: selectedChannel,
          pointId: hitPointId,
          beforeSnapshot: captureSnapshot(),
          moved: false,
        };
        return;
      }

      const existing = channelPoints.find((item) => item.x === point.x);
      if (existing) {
        setSelectedPointId(existing.id);
        dragRef.current = {
          channel: selectedChannel,
          pointId: existing.id,
          beforeSnapshot: captureSnapshot(),
          moved: false,
        };
        return;
      }

      pushUndoSnapshot(captureSnapshot());
      const pointId = getNextPointId();
      setPointsByChannel((prev) => {
        const nextPoints = [...prev[selectedChannel], { id: pointId, x: point.x, y: point.y }];
        nextPoints.sort((a, b) => a.x - b.x);
        return {
          ...prev,
          [selectedChannel]: nextPoints,
        };
      });
      setSelectedPointId(pointId);
      dragRef.current = {
        channel: selectedChannel,
        pointId,
        beforeSnapshot: null,
        moved: false,
      };
    },
    [captureSnapshot, getNextPointId, pointsByChannel, pushUndoSnapshot, selectedChannel]
  );

  const handleReset = useCallback(() => {
    pushUndoSnapshot(captureSnapshot());
    setPointsByChannel(createDefaultPoints(getNextPointId));
    setSelectedPointId(null);
  }, [captureSnapshot, getNextPointId, pushUndoSnapshot]);

  const handleCancel = useCallback(() => {
    endSession(true);
    closePanel('curves-panel');
  }, [closePanel, endSession]);

  const handleCommit = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    const win = window as CurvesBridgeWindow;
    const ok = (await win.__canvasCurvesCommit?.(sessionId, curvesPayload)) ?? false;
    if (!ok) {
      setErrorText('曲线提交失败，已保持当前图像不变。');
      return;
    }
    committedRef.current = true;
    endSession(false);
    closePanel('curves-panel');
  }, [closePanel, curvesPayload, endSession]);

  const activeLutPath = buildPathFromLut(luts[selectedChannel]);

  return (
    <div className="curves-panel">
      <div className="curves-panel__controls">
        <label className="curves-panel__field">
          <span className="curves-panel__label">Channel</span>
          <select
            className="curves-panel__select"
            value={selectedChannel}
            onChange={(event) => {
              pushUndoSnapshot(captureSnapshot());
              setSelectedChannel(event.target.value as CurvesChannel);
              setSelectedPointId(null);
            }}
          >
            {CHANNEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="curves-panel__preview-toggle">
          <input
            type="checkbox"
            checked={previewEnabled}
            onChange={(event) => {
              pushUndoSnapshot(captureSnapshot());
              setPreviewEnabled(event.target.checked);
            }}
          />
          Preview
        </label>
      </div>

      <div className="curves-panel__graph-wrap">
        <svg
          ref={graphRef}
          className="curves-panel__graph"
          viewBox={`0 0 ${GRAPH_SIZE} ${GRAPH_SIZE}`}
          role="img"
          aria-label="Curves graph"
          onPointerDown={handleGraphPointerDown}
        >
          <rect x={0} y={0} width={GRAPH_SIZE} height={GRAPH_SIZE} className="curves-panel__bg" />
          {Array.from({ length: GRID_DIVISIONS + 1 }).map((_, index) => {
            const pos = (GRAPH_SIZE / GRID_DIVISIONS) * index;
            return (
              <g key={index}>
                <line x1={pos} y1={0} x2={pos} y2={GRAPH_SIZE} className="curves-panel__grid" />
                <line x1={0} y1={pos} x2={GRAPH_SIZE} y2={pos} className="curves-panel__grid" />
              </g>
            );
          })}
          {histogramMax > 0 && (
            <path
              className="curves-panel__histogram"
              d={(() => {
                let path = `M 0 ${GRAPH_SIZE}`;
                for (let i = 0; i < histogram.length; i += 1) {
                  const value = histogram[i] ?? 0;
                  const x = toGraphX(i);
                  const y = GRAPH_SIZE - (value / histogramMax) * GRAPH_SIZE;
                  path += ` L ${x} ${y}`;
                }
                path += ` L ${GRAPH_SIZE} ${GRAPH_SIZE} Z`;
                return path;
              })()}
            />
          )}
          <line x1={0} y1={GRAPH_SIZE} x2={GRAPH_SIZE} y2={0} className="curves-panel__baseline" />
          <path d={activeLutPath} className="curves-panel__curve" />
          {activePoints.map((point) => (
            <circle
              key={point.id}
              cx={toGraphX(point.x)}
              cy={toGraphY(point.y)}
              r={point.id === selectedPointId ? 4.5 : 3.5}
              className={
                point.id === selectedPointId
                  ? 'curves-panel__point curves-panel__point--selected'
                  : 'curves-panel__point'
              }
            />
          ))}
        </svg>
      </div>

      <div className="curves-panel__io">
        <span>Input: {selectedPoint?.x ?? '-'}</span>
        <span>Output: {selectedPoint?.y ?? '-'}</span>
      </div>

      {sessionInfo && (
        <div className="curves-panel__hint">
          Target Layer: {sessionInfo.layerId} · Mode: {sessionInfo.renderMode.toUpperCase()}
        </div>
      )}
      {errorText && <div className="curves-panel__error">{errorText}</div>}

      <div className="curves-panel__history-actions">
        <button
          type="button"
          className="curves-panel__btn curves-panel__btn--ghost"
          disabled={!canUndo}
          onClick={handleLocalUndo}
        >
          Undo
        </button>
        <button
          type="button"
          className="curves-panel__btn curves-panel__btn--ghost"
          disabled={!canRedo}
          onClick={handleLocalRedo}
        >
          Redo
        </button>
      </div>

      <div className="curves-panel__actions">
        <button
          type="button"
          className="curves-panel__btn curves-panel__btn--ghost"
          onClick={handleReset}
        >
          Reset
        </button>
        <button
          type="button"
          className="curves-panel__btn curves-panel__btn--ghost"
          onClick={handleCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="curves-panel__btn curves-panel__btn--primary"
          onClick={() => void handleCommit()}
        >
          OK
        </button>
      </div>
    </div>
  );
}

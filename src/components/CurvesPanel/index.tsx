import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Redo2, Undo2 } from 'lucide-react';
import { usePanelStore } from '@/stores/panel';
import type {
  CurvePoint,
  CurvesCommitRequest,
  CurvesCommitResult,
  CurvesChannel,
  CurvesPointsByChannel,
  CurvesPreviewResult,
  CurvesPreviewPayload,
  CurvesRuntimeError,
  CurvesSessionInfo,
} from '@/types/curves';
import { buildCurveLut } from '@/utils/curvesRenderer';
import {
  CHANNEL_MAX,
  CHANNEL_MIN,
  DEFAULT_GRAPH_SIZE,
  buildSingleChannelCurvePath,
  clamp,
  getPointDragRange,
  toGraphX,
  toGraphY,
} from '@/components/CurveEditor/singleChannelCore';
import { useSingleChannelCurveEditor } from '@/components/CurveEditor/useSingleChannelCurveEditor';
import './CurvesPanel.css';

const GRAPH_SIZE = DEFAULT_GRAPH_SIZE;
const POINT_HIT_RADIUS_PX = 8;
const GRID_DIVISIONS = 4;
const CURVE_RENDER_SAMPLES = 2048;
const DRAG_DELETE_OVERSHOOT_THRESHOLD_PX = 16;

type CurvesBridgeWindow = Window & {
  __canvasCurvesBeginSession?: () => CurvesSessionInfo | null;
  __canvasCurvesPreview?: (sessionId: string, payload: CurvesPreviewPayload) => CurvesPreviewResult;
  __canvasCurvesCommit?: (
    sessionId: string,
    payload: CurvesPreviewPayload,
    request?: CurvesCommitRequest
  ) => Promise<CurvesCommitResult>;
  __canvasCurvesCancel?: (sessionId: string) => void;
};

interface CurvesPanelSnapshot {
  selectedChannel: CurvesChannel;
  previewEnabled: boolean;
  selectedPointId: string | null;
  pointsByChannel: CurvesPointsByChannel;
}

type SingleChannel = Exclude<CurvesChannel, 'rgb'>;

const CHANNEL_OPTIONS: Array<{ value: CurvesChannel; label: string }> = [
  { value: 'rgb', label: 'RGB' },
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
];

function isIdentityLut(lut: Uint8Array): boolean {
  for (let i = 0; i <= CHANNEL_MAX; i += 1) {
    if ((lut[i] ?? i) !== i) return false;
  }
  return true;
}

function getCurveClassName(channel: CurvesChannel, isOverlay = false): string {
  const overlayClass = isOverlay ? ' curves-panel__curve--overlay' : '';
  return `curves-panel__curve curves-panel__curve--${channel}${overlayClass}`;
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

function getSelectedPoint(points: CurvePoint[], selectedId: string | null): CurvePoint | null {
  if (!selectedId) return null;
  return points.find((point) => point.id === selectedId) ?? null;
}

function formatCurvesRuntimeError(error: CurvesRuntimeError | undefined, fallback: string): string {
  if (!error) return fallback;
  const phaseLabel = error.stage === 'preview' ? '预览' : '提交';
  const detail = error.detail ? `；详情：${error.detail}` : '';
  return `GPU 曲线失败（${phaseLabel}）：${error.message} [${error.code}]${detail}`;
}

function resolveHistogramByChannel(
  sessionInfo: CurvesSessionInfo | null,
  selectedChannel: CurvesChannel
): number[] {
  if (!sessionInfo) return [];
  return sessionInfo.histogramByChannel[selectedChannel] ?? sessionInfo.histogram;
}

export function CurvesPanel(): JSX.Element {
  const closePanel = usePanelStore((s) => s.closePanel);
  const pointIdRef = useRef(0);
  const graphRef = useRef<SVGSVGElement | null>(null);
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
  const [allowForceCpuCommit, setAllowForceCpuCommit] = useState(false);
  const [confirmForceCpuCommit, setConfirmForceCpuCommit] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [inputValueDraft, setInputValueDraft] = useState('');
  const [outputValueDraft, setOutputValueDraft] = useState('');
  const [, setHistoryVersion] = useState(0);

  const activePoints = pointsByChannel[selectedChannel];
  const selectedPoint = getSelectedPoint(activePoints, selectedPointId);
  const canUndo = undoStackRef.current.length > 0;
  const canRedo = redoStackRef.current.length > 0;

  const luts = useMemo(() => {
    return {
      rgb: buildCurveLut(pointsByChannel.rgb, { endpointMode: 'control_points' }),
      red: buildCurveLut(pointsByChannel.red, { endpointMode: 'control_points' }),
      green: buildCurveLut(pointsByChannel.green, { endpointMode: 'control_points' }),
      blue: buildCurveLut(pointsByChannel.blue, { endpointMode: 'control_points' }),
    };
  }, [pointsByChannel]);

  const histogram = resolveHistogramByChannel(sessionInfo, selectedChannel);
  const histogramMax = histogram.reduce((max, value) => Math.max(max, value), 0);

  const adjustedChannels = useMemo(
    () => ({
      red: !isIdentityLut(luts.red),
      green: !isIdentityLut(luts.green),
      blue: !isIdentityLut(luts.blue),
    }),
    [luts.blue, luts.green, luts.red]
  );

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

  const setActiveChannelPoints = useCallback(
    (updater: (prev: CurvePoint[]) => CurvePoint[]) => {
      setPointsByChannel((prev) => {
        const channelPoints = prev[selectedChannel];
        const nextPoints = updater(channelPoints);
        if (nextPoints === channelPoints) return prev;
        return {
          ...prev,
          [selectedChannel]: nextPoints,
        };
      });
    },
    [selectedChannel]
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

  const { curvePath: activeCurvePath, handleGraphPointerDown } = useSingleChannelCurveEditor({
    graphRef,
    points: activePoints,
    setPoints: setActiveChannelPoints,
    selectedPointId,
    setSelectedPointId,
    createPointId: getNextPointId,
    pointHitRadiusPx: POINT_HIT_RADIUS_PX,
    dragDeleteOvershootThresholdPx: DRAG_DELETE_OVERSHOOT_THRESHOLD_PX,
    curveSampleCount: CURVE_RENDER_SAMPLES,
    graphSize: GRAPH_SIZE,
    isDeleteKeyEnabled: () => Boolean(sessionIdRef.current) && !isCommitting,
    shouldIgnoreDeleteKeyTarget: isEditableTarget,
    onBeforeAddPoint: () => {
      pushUndoSnapshot(captureSnapshot());
    },
    onBeforeDeleteByKey: () => {
      pushUndoSnapshot(captureSnapshot());
    },
    onDragStart: () => captureSnapshot(),
    onDragCommit: ({ moved, deleted, token }) => {
      if ((moved || deleted) && token) {
        pushUndoSnapshot(token as CurvesPanelSnapshot);
      }
    },
  });

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
      const result = win.__canvasCurvesPreview?.(sessionId, latestPayload);
      if (!result) return;
      if (!result.ok && result.error?.stage === 'preview') {
        setErrorText(formatCurvesRuntimeError(result.error, 'GPU 曲线预览失败，预览已停止。'));
        setAllowForceCpuCommit(false);
        setConfirmForceCpuCommit(false);
      }
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
      setAllowForceCpuCommit(false);
      setConfirmForceCpuCommit(false);
      setIsCommitting(false);
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
    setAllowForceCpuCommit(false);
    setConfirmForceCpuCommit(false);
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
    if (!selectedPoint) {
      setInputValueDraft('');
      setOutputValueDraft('');
      return;
    }
    setInputValueDraft(String(selectedPoint.x));
    setOutputValueDraft(String(selectedPoint.y));
  }, [selectedPoint]);

  useEffect(() => {
    latestPayloadRef.current = curvesPayload;
    setConfirmForceCpuCommit(false);
    requestPreviewFrame();
  }, [curvesPayload, requestPreviewFrame]);

  useEffect(() => {
    const handlePanelKeyDown = (event: KeyboardEvent): void => {
      if (!sessionIdRef.current) return;
      if (isCommitting) return;
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
    };

    window.addEventListener('keydown', handlePanelKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handlePanelKeyDown, true);
    };
  }, [handleLocalRedo, handleLocalUndo, isCommitting]);

  const applySelectedPointInput = useCallback(
    (axis: 'x' | 'y', rawValue: string) => {
      if (!selectedPointId) return;
      const parsed = Number.parseInt(rawValue, 10);
      if (!Number.isFinite(parsed)) {
        const currentPoint = currentSnapshotRef.current.pointsByChannel[selectedChannel].find(
          (point) => point.id === selectedPointId
        );
        if (!currentPoint) return;
        setInputValueDraft(String(currentPoint.x));
        setOutputValueDraft(String(currentPoint.y));
        return;
      }

      const nextValue = clamp(Math.round(parsed), CHANNEL_MIN, CHANNEL_MAX);
      const livePoints = currentSnapshotRef.current.pointsByChannel[selectedChannel];
      const index = livePoints.findIndex((point) => point.id === selectedPointId);
      if (index < 0) return;
      const current = livePoints[index];
      if (!current) return;

      const dragRange = getPointDragRange(livePoints, index);
      const nextPoint: CurvePoint = {
        ...current,
        x: axis === 'x' ? clamp(nextValue, dragRange.minX, dragRange.maxX) : current.x,
        y: axis === 'y' ? clamp(nextValue, dragRange.minY, dragRange.maxY) : current.y,
      };
      setInputValueDraft(String(nextPoint.x));
      setOutputValueDraft(String(nextPoint.y));

      if (nextPoint.x === current.x && nextPoint.y === current.y) return;

      const beforeSnapshot = captureSnapshot();
      setPointsByChannel((prev) => {
        const channelPoints = prev[selectedChannel];
        const nextIndex = channelPoints.findIndex((point) => point.id === selectedPointId);
        if (nextIndex < 0) return prev;
        const existing = channelPoints[nextIndex];
        if (!existing) return prev;

        const nextPoints = [...channelPoints];
        nextPoints[nextIndex] = {
          ...existing,
          x: nextPoint.x,
          y: nextPoint.y,
        };
        return {
          ...prev,
          [selectedChannel]: nextPoints,
        };
      });
      pushUndoSnapshot(beforeSnapshot);
    },
    [captureSnapshot, pushUndoSnapshot, selectedChannel, selectedPointId]
  );

  const handleIoInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.currentTarget.blur();
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (selectedPoint) {
        setInputValueDraft(String(selectedPoint.x));
        setOutputValueDraft(String(selectedPoint.y));
      }
      event.currentTarget.blur();
    },
    [selectedPoint]
  );

  const handleReset = useCallback(() => {
    pushUndoSnapshot(captureSnapshot());
    setPointsByChannel(createDefaultPoints(getNextPointId));
    setSelectedPointId(null);
  }, [captureSnapshot, getNextPointId, pushUndoSnapshot]);

  const handleCancel = useCallback(() => {
    if (isCommitting) return;
    endSession(true);
    closePanel('curves-panel');
  }, [closePanel, endSession, isCommitting]);

  const handleCommit = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || isCommitting) return;
    const win = window as CurvesBridgeWindow;
    setIsCommitting(true);
    try {
      const result = await win.__canvasCurvesCommit?.(sessionId, curvesPayload);
      if (!result?.ok) {
        setAllowForceCpuCommit(Boolean(result?.canForceCpuCommit));
        setConfirmForceCpuCommit(false);
        setErrorText(formatCurvesRuntimeError(result?.error, '曲线提交失败，已保持当前图像不变。'));
        return;
      }
      committedRef.current = true;
      endSession(false);
      closePanel('curves-panel');
    } finally {
      setIsCommitting(false);
    }
  }, [closePanel, curvesPayload, endSession, isCommitting]);

  const handleForceCpuCommit = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || !allowForceCpuCommit || isCommitting) return;
    if (!confirmForceCpuCommit) {
      setConfirmForceCpuCommit(true);
      setErrorText('GPU 提交已失败。再次点击“使用 CPU 提交”以确认执行应急提交。');
      return;
    }

    const win = window as CurvesBridgeWindow;
    setIsCommitting(true);
    try {
      const result = await win.__canvasCurvesCommit?.(sessionId, curvesPayload, { forceCpu: true });
      if (!result?.ok) {
        setAllowForceCpuCommit(Boolean(result?.canForceCpuCommit));
        setConfirmForceCpuCommit(false);
        setErrorText(formatCurvesRuntimeError(result?.error, 'CPU 曲线提交失败，图像未修改。'));
        return;
      }

      committedRef.current = true;
      endSession(false);
      closePanel('curves-panel');
    } finally {
      setIsCommitting(false);
    }
  }, [
    allowForceCpuCommit,
    closePanel,
    confirmForceCpuCommit,
    curvesPayload,
    endSession,
    isCommitting,
  ]);

  const rgbOverlayCurves = useMemo(() => {
    if (selectedChannel !== 'rgb') return [];
    const singleChannels: SingleChannel[] = ['red', 'green', 'blue'];
    const activeOverlays: Array<{ channel: SingleChannel; path: string }> = [];

    for (const channel of singleChannels) {
      if (!adjustedChannels[channel]) continue;
      const path = buildSingleChannelCurvePath(pointsByChannel[channel], {
        sampleCount: CURVE_RENDER_SAMPLES,
        graphSize: GRAPH_SIZE,
      });
      activeOverlays.push({ channel, path });
    }

    return activeOverlays;
  }, [adjustedChannels, pointsByChannel, selectedChannel]);

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
          {rgbOverlayCurves.map((curve) => (
            <path
              key={`overlay-${curve.channel}`}
              d={curve.path}
              className={getCurveClassName(curve.channel, true)}
              shapeRendering="geometricPrecision"
            />
          ))}
          <path
            d={activeCurvePath}
            className={getCurveClassName(selectedChannel)}
            shapeRendering="geometricPrecision"
          />
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
        <label className="curves-panel__io-field">
          <span>Input:</span>
          <input
            type="number"
            min={0}
            max={255}
            step={1}
            className="curves-panel__io-input"
            aria-label="Input value"
            value={selectedPoint ? inputValueDraft : ''}
            placeholder="-"
            disabled={!selectedPoint}
            onChange={(event) => setInputValueDraft(event.target.value)}
            onBlur={() => applySelectedPointInput('x', inputValueDraft)}
            onKeyDown={handleIoInputKeyDown}
          />
        </label>
        <label className="curves-panel__io-field">
          <span>Output:</span>
          <input
            type="number"
            min={0}
            max={255}
            step={1}
            className="curves-panel__io-input"
            aria-label="Output value"
            value={selectedPoint ? outputValueDraft : ''}
            placeholder="-"
            disabled={!selectedPoint}
            onChange={(event) => setOutputValueDraft(event.target.value)}
            onBlur={() => applySelectedPointInput('y', outputValueDraft)}
            onKeyDown={handleIoInputKeyDown}
          />
        </label>
      </div>

      {errorText && <div className="curves-panel__error">{errorText}</div>}

      <div className="curves-panel__history-actions">
        <button
          type="button"
          className="curves-panel__icon-btn"
          disabled={!canUndo || isCommitting}
          onClick={handleLocalUndo}
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
        >
          <Undo2 size={16} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="curves-panel__icon-btn"
          disabled={!canRedo || isCommitting}
          onClick={handleLocalRedo}
          title="Redo (Ctrl+Y)"
          aria-label="Redo"
        >
          <Redo2 size={16} strokeWidth={1.5} />
        </button>
      </div>

      <div className="curves-panel__actions">
        <button
          type="button"
          className="curves-panel__btn curves-panel__btn--ghost"
          disabled={isCommitting}
          onClick={handleReset}
        >
          Reset
        </button>
        <button
          type="button"
          className="curves-panel__btn curves-panel__btn--ghost"
          disabled={isCommitting}
          onClick={handleCancel}
        >
          Cancel
        </button>
        {allowForceCpuCommit && (
          <button
            type="button"
            className="curves-panel__btn curves-panel__btn--ghost"
            disabled={isCommitting}
            onClick={() => void handleForceCpuCommit()}
          >
            {confirmForceCpuCommit ? '确认使用 CPU 提交' : '使用 CPU 提交'}
          </button>
        )}
        <button
          type="button"
          className="curves-panel__btn curves-panel__btn--primary"
          disabled={isCommitting}
          onClick={() => void handleCommit()}
        >
          OK
        </button>
      </div>
    </div>
  );
}

export type StrokeCaptureEventType = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';

export interface StrokeCaptureSample {
  type: StrokeCaptureEventType;
  timeMs: number;
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  pointerType: string;
  pointerId: number;
  buttons: number;
}

export interface StrokeCaptureMetadata {
  canvasWidth: number;
  canvasHeight: number;
  viewportScale: number;
  tool: Record<string, unknown>;
}

export interface StrokeCaptureData {
  version: 1;
  createdAt: string;
  metadata: StrokeCaptureMetadata;
  samples: StrokeCaptureSample[];
}

export interface StrokeReplayOptions {
  speed?: number;
  pointerTypeOverride?: 'pen' | 'mouse';
}

interface StrokeCaptureControllerParams {
  getCanvas: () => HTMLCanvasElement | null;
  getCaptureRoot?: () => HTMLElement | null;
  getScale: () => number;
  getMetadata: () => StrokeCaptureMetadata;
}

interface ReplayResult {
  events: number;
  durationMs: number;
}

const POINTER_TYPES = new Set<StrokeCaptureEventType>([
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
]);

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isValidCaptureData(value: unknown): value is StrokeCaptureData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<StrokeCaptureData>;
  return data.version === 1 && Array.isArray(data.samples) && !!data.metadata;
}

export class StrokeCaptureController {
  private isRecording = false;
  private startedAtMs = 0;
  private samples: StrokeCaptureSample[] = [];
  private lastCapture: StrokeCaptureData | null = null;
  private detach: (() => void) | null = null;
  private activePointerIds = new Set<number>();
  private readonly onPointerEvent: (event: PointerEvent) => void;

  constructor(private readonly params: StrokeCaptureControllerParams) {
    this.onPointerEvent = (event: PointerEvent) => {
      if (!this.isRecording) return;
      const eventType = event.type as StrokeCaptureEventType;
      if (!POINTER_TYPES.has(eventType)) return;

      const canvas = this.params.getCanvas();
      if (!canvas) return;
      const captureRoot = this.params.getCaptureRoot?.() ?? canvas;

      const scale = this.params.getScale();
      if (!(scale > 0)) return;

      const rect = canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) / scale;
      const y = (event.clientY - rect.top) / scale;
      const isInsideCanvas = x >= 0 && y >= 0 && x <= canvas.width && y <= canvas.height;
      const targetNode = event.target as Node | null;
      const isWithinRoot = targetNode ? captureRoot.contains(targetNode) : false;
      const pointerId = event.pointerId ?? 1;

      if (eventType === 'pointerdown') {
        if (!isWithinRoot && !isInsideCanvas) return;
        this.activePointerIds.add(pointerId);
      } else if (!this.activePointerIds.has(pointerId)) {
        return;
      }

      // Ignore hover-only moves; keep actual drawing moves.
      if (eventType === 'pointermove' && event.buttons === 0 && event.pressure === 0) {
        return;
      }

      this.samples.push({
        type: eventType,
        timeMs: Math.max(0, performance.now() - this.startedAtMs),
        x,
        y,
        pressure: event.pressure ?? 0,
        tiltX: event.tiltX ?? 0,
        tiltY: event.tiltY ?? 0,
        pointerType: event.pointerType || 'pen',
        pointerId,
        buttons: event.buttons ?? 0,
      });

      if (eventType === 'pointerup' || eventType === 'pointercancel') {
        this.activePointerIds.delete(pointerId);
      }
    };
  }

  start(): boolean {
    if (this.isRecording) return false;
    const canvas = this.params.getCanvas();
    if (!canvas) return false;

    this.isRecording = true;
    this.startedAtMs = performance.now();
    this.samples = [];
    this.activePointerIds.clear();

    const handler = this.onPointerEvent as EventListener;
    window.addEventListener('pointerdown', handler, true);
    window.addEventListener('pointermove', handler, true);
    window.addEventListener('pointerup', handler, true);
    window.addEventListener('pointercancel', handler, true);

    this.detach = () => {
      window.removeEventListener('pointerdown', handler, true);
      window.removeEventListener('pointermove', handler, true);
      window.removeEventListener('pointerup', handler, true);
      window.removeEventListener('pointercancel', handler, true);
    };

    return true;
  }

  stop(): StrokeCaptureData | null {
    if (!this.isRecording) return this.lastCapture;

    this.isRecording = false;
    this.detach?.();
    this.detach = null;
    this.activePointerIds.clear();

    this.lastCapture = {
      version: 1,
      createdAt: new Date().toISOString(),
      metadata: this.params.getMetadata(),
      samples: this.samples.slice(),
    };
    return this.lastCapture;
  }

  cancel(): void {
    this.isRecording = false;
    this.samples = [];
    this.detach?.();
    this.detach = null;
    this.activePointerIds.clear();
  }

  getLastCapture(): StrokeCaptureData | null {
    return this.lastCapture;
  }

  setLastCapture(capture: StrokeCaptureData): void {
    this.lastCapture = capture;
  }

  parseCapture(input: unknown): StrokeCaptureData | null {
    if (!input) return this.lastCapture;
    if (typeof input === 'string') {
      try {
        const parsed = JSON.parse(input);
        if (isValidCaptureData(parsed)) return parsed;
      } catch {
        return null;
      }
      return null;
    }
    if (isValidCaptureData(input)) return input;
    return null;
  }

  async replay(input?: unknown, options: StrokeReplayOptions = {}): Promise<ReplayResult | null> {
    const capture = this.parseCapture(input);
    if (!capture) return null;
    const canvas = this.params.getCanvas();
    if (!canvas) return null;

    this.lastCapture = capture;
    const speed = Math.max(0.1, options.speed ?? 1);
    const samples = capture.samples;
    if (samples.length === 0) return { events: 0, durationMs: 0 };

    const startedAt = performance.now();
    let prevTimeMs = samples[0]!.timeMs;
    const downState = new Set<number>();

    const dispatch = (
      type: StrokeCaptureEventType,
      sample: StrokeCaptureSample,
      override?: Partial<PointerEventInit>
    ) => {
      const scale = this.params.getScale();
      if (!(scale > 0)) return;
      const rect = canvas.getBoundingClientRect();
      const clientX = rect.left + sample.x * scale;
      const clientY = rect.top + sample.y * scale;
      const pointerType = options.pointerTypeOverride ?? sample.pointerType;
      const pressure = type === 'pointerup' ? 0 : sample.pressure;

      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: sample.pointerId,
        pointerType,
        isPrimary: true,
        clientX,
        clientY,
        pressure,
        tiltX: sample.tiltX,
        tiltY: sample.tiltY,
        buttons: type === 'pointerup' ? 0 : sample.buttons,
        ...override,
      });
      canvas.dispatchEvent(event);
    };

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i]!;
      if (i > 0) {
        const delta = (sample.timeMs - prevTimeMs) / speed;
        await wait(delta);
      }
      prevTimeMs = sample.timeMs;

      // Backward compatibility: old captures may start with move events.
      if (sample.type !== 'pointerdown' && !downState.has(sample.pointerId)) {
        dispatch('pointerdown', sample, {
          pressure: sample.pressure > 0 ? sample.pressure : 0.5,
          buttons: sample.buttons || 1,
        });
        downState.add(sample.pointerId);
      }

      dispatch(sample.type, sample);
      if (sample.type === 'pointerdown') downState.add(sample.pointerId);
      if (sample.type === 'pointerup' || sample.type === 'pointercancel') {
        downState.delete(sample.pointerId);
      }
    }

    // Ensure all active pointers are released to keep state machine consistent.
    if (downState.size > 0) {
      const tailSample = samples[samples.length - 1]!;
      for (const pointerId of downState) {
        dispatch('pointerup', {
          ...tailSample,
          pointerId,
          pressure: 0,
          buttons: 0,
          type: 'pointerup',
        });
      }
    }

    return {
      events: samples.length,
      durationMs: performance.now() - startedAt,
    };
  }

  download(fileName?: string, input?: unknown): boolean {
    let capture = this.parseCapture(input);
    if (!capture && input === undefined && this.isRecording) {
      capture = this.stop();
    }
    if (!capture) return false;
    this.lastCapture = capture;

    const serialized = JSON.stringify(capture, null, 2);
    const blob = new Blob([serialized], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const fallbackName = `stroke-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.href = url;
    a.download = fileName || fallbackName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  }
}

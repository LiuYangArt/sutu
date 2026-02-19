/**
 * Diagnostic Hooks for stroke state machine telemetry
 * Detects conditions that could cause flicker through logical instrumentation
 * Does NOT interfere with rendering (no getImageData during strokes)
 */

export type StrokeState = 'starting' | 'active' | 'finishing' | 'completed' | 'error';

export interface StrokeTelemetry {
  strokeId: number;
  startTime: number;
  endTime?: number;
  state: StrokeState;
  bufferedPoints: number;
  droppedPoints: number;
  startingDuration?: number; // How long the 'starting' state lasted
}

export interface Anomaly {
  type: 'long_starting' | 'buffer_cleared' | 'premature_end' | 'point_dropped';
  strokeId: number;
  timestamp: number;
  details: string;
}

export interface DiagnosticAPI {
  onStrokeStart: () => void;
  onStateChange: (newState: string) => void;
  onPointBuffered: () => void;
  onPointDropped: () => void;
  onStrokeEnd: () => void;
}

export interface DiagnosticHooks extends DiagnosticAPI {
  strokes: StrokeTelemetry[];
  currentStroke: StrokeTelemetry | null;
  anomalies: Anomaly[];
  cleanup: () => void;
  reset: () => void;
}

// Threshold for flagging long 'starting' state (ms)
const LONG_STARTING_THRESHOLD_MS = 100;

/**
 * Install diagnostic hooks on window for Canvas component to call
 */
export function installDiagnosticHooks(): DiagnosticHooks {
  let strokeCounter = 0;

  const hooks: DiagnosticHooks = {
    strokes: [],
    currentStroke: null,
    anomalies: [],

    onStrokeStart() {
      const stroke: StrokeTelemetry = {
        strokeId: ++strokeCounter,
        startTime: performance.now(),
        state: 'starting',
        bufferedPoints: 0,
        droppedPoints: 0,
      };
      hooks.currentStroke = stroke;
      hooks.strokes.push(stroke);
    },

    onStateChange(newState: string) {
      if (!hooks.currentStroke) return;

      const stroke = hooks.currentStroke;
      const prevState = stroke.state;
      stroke.state = newState as StrokeState;

      // Detect anomaly: 'starting' state took too long
      if (prevState === 'starting' && newState === 'active') {
        stroke.startingDuration = performance.now() - stroke.startTime;
        if (stroke.startingDuration > LONG_STARTING_THRESHOLD_MS) {
          hooks.anomalies.push({
            type: 'long_starting',
            strokeId: stroke.strokeId,
            timestamp: performance.now(),
            details: `Starting state lasted ${stroke.startingDuration.toFixed(0)}ms (threshold: ${LONG_STARTING_THRESHOLD_MS}ms)`,
          });
        }
      }

      // Detect anomaly: premature end while still 'starting'
      if (prevState === 'starting' && (newState === 'completed' || newState === 'finishing')) {
        hooks.anomalies.push({
          type: 'premature_end',
          strokeId: stroke.strokeId,
          timestamp: performance.now(),
          details: `Stroke ended while still in 'starting' state`,
        });
      }
    },

    onPointBuffered() {
      if (hooks.currentStroke) {
        hooks.currentStroke.bufferedPoints++;
      }
    },

    onPointDropped() {
      if (hooks.currentStroke) {
        hooks.currentStroke.droppedPoints++;
        hooks.anomalies.push({
          type: 'point_dropped',
          strokeId: hooks.currentStroke.strokeId,
          timestamp: performance.now(),
          details: `Point dropped during stroke`,
        });
      }
    },

    onStrokeEnd() {
      if (hooks.currentStroke) {
        hooks.currentStroke.endTime = performance.now();
        hooks.currentStroke.state = 'completed';
        hooks.currentStroke = null;
      }
    },

    cleanup() {
      const win = window as Window & { __strokeDiagnostics?: DiagnosticHooks };
      delete win.__strokeDiagnostics;
    },

    reset() {
      hooks.strokes = [];
      hooks.currentStroke = null;
      hooks.anomalies = [];
      strokeCounter = 0;
    },
  };

  // Mount on window for Canvas component to call
  const win = window as Window & { __strokeDiagnostics?: DiagnosticHooks };
  win.__strokeDiagnostics = hooks;

  return hooks;
}

/**
 * Get diagnostic hooks if installed
 */
export function getDiagnosticHooks(): DiagnosticHooks | null {
  const win = window as Window & { __strokeDiagnostics?: DiagnosticHooks };
  return win.__strokeDiagnostics ?? null;
}

/**
 * Generate a test report from diagnostic data
 */
export function getTestReport(hooks: DiagnosticHooks): string {
  const completed = hooks.strokes.filter((s) => s.state === 'completed').length;
  const totalDropped = hooks.strokes.reduce((sum, s) => sum + s.droppedPoints, 0);
  const totalBuffered = hooks.strokes.reduce((sum, s) => sum + s.bufferedPoints, 0);

  const startingDurations = hooks.strokes
    .filter((s) => s.startingDuration !== undefined)
    .map((s) => s.startingDuration!);
  const avgStarting =
    startingDurations.length > 0
      ? startingDurations.reduce((a, b) => a + b, 0) / startingDurations.length
      : 0;
  const maxStarting = startingDurations.length > 0 ? Math.max(...startingDurations) : 0;

  const lines: string[] = [
    '=== Stroke Telemetry Report ===',
    `Total Strokes: ${hooks.strokes.length}`,
    `Completed: ${completed}`,
    `Total Buffered Points: ${totalBuffered}`,
    `Total Dropped Points: ${totalDropped}`,
    `Avg Starting Duration: ${avgStarting.toFixed(1)}ms`,
    `Max Starting Duration: ${maxStarting.toFixed(1)}ms`,
    `Anomalies: ${hooks.anomalies.length}`,
  ];

  if (hooks.anomalies.length > 0) {
    lines.push('');
    lines.push('Anomaly Details:');
    hooks.anomalies.slice(0, 20).forEach((a, i) => {
      lines.push(`  ${i + 1}. [${a.type}] Stroke #${a.strokeId}: ${a.details}`);
    });
    if (hooks.anomalies.length > 20) {
      lines.push(`  ... and ${hooks.anomalies.length - 20} more`);
    }
  }

  const passed = hooks.anomalies.length === 0 && totalDropped === 0;
  lines.push('');
  lines.push(`Status: ${passed ? '✅ PASSED' : '❌ ISSUES DETECTED'}`);

  return lines.join('\n');
}

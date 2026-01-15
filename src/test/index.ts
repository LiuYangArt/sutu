/**
 * Test utilities for PaintBoard
 */

// Input simulation
export { InputSimulator } from './InputSimulator';
export type { TapOptions, GridOptions, StrokeOptions, Point } from './InputSimulator';

// Grid verification
export { verifyGrid, formatVerificationReport } from './GridVerifier';
export type { VerificationResult, VerifyOptions } from './GridVerifier';

// Diagnostic hooks
export { installDiagnosticHooks, getDiagnosticHooks, getTestReport } from './DiagnosticHooks';
export type {
  StrokeTelemetry,
  StrokeState,
  Anomaly,
  DiagnosticHooks,
  DiagnosticAPI,
} from './DiagnosticHooks';

// Chaos testing
export { chaosClicker, chaosMixed, formatChaosReport } from './ChaosTest';
export type { ChaosTestResult, ChaosTestOptions } from './ChaosTest';

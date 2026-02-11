/**
 * Test utilities for Sutu
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

// Real-input capture/replay
export { StrokeCaptureController } from './StrokeCapture';
export type {
  StrokeCaptureData,
  StrokeCaptureSample,
  StrokeCaptureMetadata,
  StrokeReplayOptions,
} from './StrokeCapture';

export {
  DEBUG_CAPTURE_DIR,
  DEBUG_CAPTURE_FILE_NAME,
  DEBUG_CAPTURE_RELATIVE_PATH,
  DEBUG_CAPTURE_LOCAL_KEY,
} from './strokeCaptureFixedFile';
export type {
  FixedCaptureSource,
  FixedStrokeCaptureSaveResult,
  FixedStrokeCaptureLoadResult,
} from './strokeCaptureFixedFile';

export {
  computeImageParityMetrics,
  isImageParityPass,
  decodeDataUrlToImageData,
  compareImageDataUrls,
  DEFAULT_MISMATCH_PIXEL_DELTA,
} from './imageParity';
export type { ImageParityMetrics, ImageParityThresholds } from './imageParity';

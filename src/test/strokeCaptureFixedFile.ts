import type { StrokeCaptureData } from './StrokeCapture';
import { appDotStorageKey } from '@/constants/appMeta';

export const DEBUG_CAPTURE_DIR = 'debug-data';
export const DEBUG_CAPTURE_FILE_NAME = 'debug-stroke-capture.json';
export const DEBUG_CAPTURE_RELATIVE_PATH = `${DEBUG_CAPTURE_DIR}/${DEBUG_CAPTURE_FILE_NAME}`;
export const DEBUG_CAPTURE_LOCAL_KEY = appDotStorageKey('debug-data.debug-stroke-capture');

export type FixedCaptureSource = 'appconfig' | 'localstorage';

export interface FixedStrokeCaptureSaveResult {
  ok: boolean;
  path: string;
  name: string;
  source: FixedCaptureSource;
  error?: string;
}

export interface FixedStrokeCaptureLoadResult {
  capture: StrokeCaptureData;
  path: string;
  name: string;
  source: FixedCaptureSource;
}

import type { ExtensionError } from '../contracts';

// Capture has eleven distinct ways to fail and used to report two. These codes
// name the one that fired; the coarse ErrorCode the task state carries is
// derived from it, so nothing downstream has to change to benefit.
export const CAPTURE_LIMITS = Object.freeze({
  commandTimeoutMs: 15_000,
  totalTimeoutMs: 120_000,
  maxPixels: 32_000_000,
  maxSide: 32_767,
  maxEncodedBytes: 128_000_000,
});
export type CaptureErrorCode =
  | 'CAPTURE_ACTIVE_TAB_CHANGED'
  | 'CAPTURE_DEBUGGER_ATTACH_FAILED'
  | 'CAPTURE_DEBUGGER_DETACHED'
  | 'CAPTURE_COMMAND_TIMEOUT'
  | 'CAPTURE_TOTAL_TIMEOUT'
  | 'CAPTURE_SCREENSHOT_FAILED'
  | 'CAPTURE_SCREENSHOT_INVALID'
  | 'CAPTURE_PIXEL_LIMIT_EXCEEDED'
  | 'CAPTURE_DIMENSION_LIMIT_EXCEEDED'
  | 'CAPTURE_ENCODED_SIZE_LIMIT_EXCEEDED'
  | 'CAPTURE_PAGE_CHANGED';

export class CaptureError extends Error {
  constructor(public readonly detail: ExtensionError & { code: CaptureErrorCode }) {
    super(detail.code);
    this.name = 'CaptureError';
  }
}
// Structure only: dimensions, byte counts, limits, method names and elapsed
// time. No pixels, page text or URLs beyond the origin already in the task.
export function captureError(code: CaptureErrorCode, message: string,
  context?: Record<string, unknown>, cause?: string): CaptureError {
  return new CaptureError({ code, stage: 'CAPTURE', message, timestamp: new Date().toISOString(),
    ...(cause ? { cause } : {}), ...(context ? { context } : {}) });
}
// Which coarse task error a precise capture code belongs to, so the panel's
// existing messages and the stored TaskState keep working unchanged.
export const captureErrorCategory = (code: CaptureErrorCode): 'PAGE_CHANGED' | 'CAPTURE_TOO_LARGE' | 'CAPTURE_FAILED' =>
  code === 'CAPTURE_ACTIVE_TAB_CHANGED' || code === 'CAPTURE_PAGE_CHANGED' ? 'PAGE_CHANGED'
  : code === 'CAPTURE_ENCODED_SIZE_LIMIT_EXCEEDED' || code === 'CAPTURE_PIXEL_LIMIT_EXCEEDED'
    || code === 'CAPTURE_DIMENSION_LIMIT_EXCEEDED' ? 'CAPTURE_TOO_LARGE'
  : 'CAPTURE_FAILED';

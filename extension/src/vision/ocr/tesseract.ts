import { PerceptionResultSchema, type PerceptionAdapter, type PerceptionInput, type PerceptionResult } from '../contracts';

export interface OcrProgress { status: string; progress: number }

export class TesseractAdapter implements PerceptionAdapter {
  private worker?: Worker;
  private cancel?: () => void;

  constructor(private readonly onProgress: (progress: OcrProgress) => void = () => {}, private readonly timeoutMs = 90_000) {}

  dispose() {
    this.cancel?.();
    this.worker?.terminate();
    this.worker = undefined;
  }

  inspect(input: PerceptionInput, signal: AbortSignal): Promise<PerceptionResult> {
    if (signal.aborted || this.cancel) {
      input.image.close();
      return Promise.reject(new Error(signal.aborted ? 'STOPPED' : 'OCR_BUSY'));
    }
    return new Promise((resolve, reject) => {
      const width = input.image.width, height = input.image.height;
      try { this.worker ??= new Worker(new URL('./tesseract.worker.ts', import.meta.url), { type: 'module' }); }
      catch { input.image.close(); reject(new Error('OCR_FAILED')); return; }
      const worker = this.worker;
      const cleanup = () => {
        clearTimeout(deadline);
        signal.removeEventListener('abort', abort);
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
        this.cancel = undefined;
        input.image.close();
      };
      const fail = (code: string) => {
        cleanup(); worker.terminate(); this.worker = undefined; reject(new Error(code));
      };
      const abort = () => fail('STOPPED');
      const deadline = setTimeout(() => fail('OCR_TIMEOUT'), this.timeoutMs);
      this.cancel = abort;
      signal.addEventListener('abort', abort, { once: true });
      worker.onerror = () => fail('OCR_FAILED');
      worker.onmessageerror = () => fail('OCR_FAILED');
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress' && data.observationId === input.observationId) {
          if (typeof data.status === 'string' && Number.isFinite(data.progress)) this.onProgress({ status: data.status, progress: Math.max(0, Math.min(1, data.progress)) });
        } else if (data.type === 'error' && data.observationId === input.observationId) {
          fail(data.code === 'OCR_TOO_MUCH_TEXT' ? data.code : 'OCR_FAILED');
        } else if (data.type === 'result') {
          const result = PerceptionResultSchema.safeParse(data.result);
          if (!result.success || result.data.observationId !== input.observationId || result.data.source !== 'model' ||
            result.data.regions.some(({ kind, bounds: b }) => kind !== 'text' || b.x < 0 || b.y < 0 || b.x + b.width > width || b.y + b.height > height)) {
            fail('OCR_INVALID_RESULT'); return;
          }
          cleanup(); resolve(result.data);
        }
      };
      try { worker.postMessage({ ...input, assetRoot: chrome.runtime.getURL('ocr') }, [input.image]); }
      catch { fail('OCR_FAILED'); }
    });
  }
}

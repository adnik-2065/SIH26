import { PerceptionResultSchema, type PerceptionAdapter, type PerceptionInput, type PerceptionResult } from '../contracts';
import { mergeRuntimes, newDetectorRuntime, readRuntimeSample, recordRuntime, resetRuntime } from '../../metrics/timings';

export interface OcrProgress { status: string; progress: number }

export class TesseractAdapter implements PerceptionAdapter {
  private worker?: Worker;
  private cancel?: () => void;
  // Where this engine's time went, for the run log.
  readonly runtime = newDetectorRuntime();

  constructor(private readonly onProgress: (progress: OcrProgress) => void = () => {}, private readonly timeoutMs = 90_000) {}

  dispose() {
    this.cancel?.();
    this.worker?.terminate();
    this.worker = undefined;
  }

  get busy() { return !!this.cancel; }

  // Loads the engine ahead of the first inspection. A failure here is left for
  // that inspection to meet and report.
  warm() {
    try {
      this.worker ??= new Worker(new URL('./tesseract.worker.ts', import.meta.url), { type: 'module' });
      this.worker.postMessage({ type: 'warm', assetRoot: chrome.runtime.getURL('ocr') });
    } catch { /* the next inspection creates the worker and reports its failure */ }
  }

  inspect(input: PerceptionInput, signal: AbortSignal): Promise<PerceptionResult> {
    if (signal.aborted || this.cancel) {
      input.image.close();
      return Promise.reject(new Error(signal.aborted ? 'STOPPED' : 'OCR_BUSY'));
    }
    return new Promise((resolve, reject) => {
      const width = input.image.width, height = input.image.height;
      try { this.worker ??= new Worker(new URL('./tesseract.worker.ts', import.meta.url), { type: 'module' }); }
      catch { input.image.close(); reject(new Error('OCR_WORKER_INIT_FAILED')); return; }
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
      worker.onerror = () => fail('OCR_EXECUTION_FAILED');
      worker.onmessageerror = () => fail('OCR_EXECUTION_FAILED');
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress' && data.observationId === input.observationId) {
          if (typeof data.status === 'string' && Number.isFinite(data.progress)) this.onProgress({ status: data.status, progress: Math.max(0, Math.min(1, data.progress)) });
        } else if (data.type === 'error' && data.observationId === input.observationId) {
          // The worker classified its own failure; keep that code rather than
          // flattening every engine fault into one.
          fail(typeof data.code === 'string' && data.code.startsWith('OCR_') ? data.code : 'OCR_EXECUTION_FAILED');
        } else if (data.type === 'result') {
          const result = PerceptionResultSchema.safeParse(data.result);
          // Three different faults used to share one code: a result that does
          // not parse, a result for another observation, and boxes outside the
          // image it was given.
          if (!result.success) { fail('OCR_NORMALIZATION_FAILED'); return; }
          if (result.data.observationId !== input.observationId || result.data.source !== 'model') { fail('OCR_INVALID_OBSERVATION'); return; }
          if (result.data.regions.some(({ kind, bounds: b }) => kind !== 'text' || b.x < 0 || b.y < 0 || b.x + b.width > width || b.y + b.height > height)) {
            fail('OCR_INVALID_BOUNDS'); return;
          }
          const sample = readRuntimeSample(data.runtime);
          if (sample) recordRuntime(this.runtime, sample);
          cleanup(); resolve(result.data);
        }
      };
      try { worker.postMessage({ ...input, assetRoot: chrome.runtime.getURL('ocr') }, [input.image]); }
      catch { fail('OCR_EXECUTION_FAILED'); }
    });
  }
}

// Several engines, each on its own worker, so the strips of one screen are read
// side by side. Each lane is an ordinary single-worker adapter.
export class TesseractPool implements PerceptionAdapter {
  private readonly pool: TesseractAdapter[];

  constructor(readonly lanes: number, onProgress: (progress: OcrProgress) => void = () => {}) {
    this.pool = Array.from({ length: Math.max(1, lanes) }, () => new TesseractAdapter(onProgress));
  }

  dispose() { for (const lane of this.pool) lane.dispose(); }

  warm() { for (const lane of this.pool) lane.warm(); }

  get runtime() { return mergeRuntimes(this.pool.map(lane => lane.runtime)); }
  resetRuntime() { for (const lane of this.pool) resetRuntime(lane.runtime); }

  inspect(input: PerceptionInput, signal: AbortSignal): Promise<PerceptionResult> {
    const lane = this.pool.find(candidate => !candidate.busy);
    if (!lane) { input.image.close(); return Promise.reject(new Error(signal.aborted ? 'STOPPED' : 'OCR_BUSY')); }
    return lane.inspect(input, signal);
  }
}

// Leave cores for the face and document detectors running alongside, and cap
// the engines' memory: each lane holds its own model.
export const ocrLanes = (cores = navigator.hardwareConcurrency || 1) => Math.max(1, Math.min(4, Math.floor(cores / 3)));

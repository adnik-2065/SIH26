import { PerceptionResultSchema, type PerceptionAdapter, type PerceptionInput, type PerceptionResult } from '../contracts';
import { newDetectorRuntime, readRuntimeSample, recordRuntime } from '../../metrics/timings';

export class MediaPipeAdapter implements PerceptionAdapter {
  private worker?: Worker;
  private cancel?: () => void;
  // Where the detector's time went, for the run log.
  readonly runtime = newDetectorRuntime();
  constructor(private readonly timeoutMs = 30_000) {}

  dispose() {
    this.cancel?.();
    this.worker?.terminate();
    this.worker = undefined;
  }

  // Loads the detector ahead of the first inspection, which reports any failure.
  warm() {
    try {
      this.worker ??= new Worker(chrome.runtime.getURL('vision/face.worker.js'));
      this.worker.postMessage({ type: 'warm', assetRoot: chrome.runtime.getURL('vision') });
    } catch { /* the next inspection creates the worker and reports its failure */ }
  }

  inspect(input: PerceptionInput, signal: AbortSignal): Promise<PerceptionResult> {
    if (signal.aborted || this.cancel) {
      input.image.close();
      return Promise.reject(new Error(signal.aborted ? 'STOPPED' : 'FACE_BUSY'));
    }
    return new Promise((resolve, reject) => {
      const { width, height } = input.image;
      // A separately bundled classic worker supports MediaPipe's WASM loader.
      try { this.worker ??= new Worker(chrome.runtime.getURL('vision/face.worker.js')); }
      catch { input.image.close(); reject(new Error('FACE_FAILED')); return; }
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
      const deadline = setTimeout(() => fail('FACE_TIMEOUT'), this.timeoutMs);
      this.cancel = abort;
      signal.addEventListener('abort', abort, { once: true });
      worker.onerror = () => fail('FACE_FAILED');
      worker.onmessageerror = () => fail('FACE_FAILED');
      worker.onmessage = ({ data }) => {
        if (data?.type === 'error') { fail('FACE_FAILED'); return; }
        const result = PerceptionResultSchema.safeParse(data?.result);
        if (data?.type !== 'result' || !result.success || result.data.source !== 'model' || result.data.observationId !== input.observationId ||
          result.data.regions.some(({ kind, bounds: b }) => kind !== 'face' || b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 || b.x + b.width > width || b.y + b.height > height)) {
          fail('FACE_INVALID_RESULT'); return;
        }
        const sample = readRuntimeSample(data.runtime);
        if (sample) recordRuntime(this.runtime, sample);
        cleanup(); resolve(result.data);
      };
      try { worker.postMessage({ ...input, assetRoot: chrome.runtime.getURL('vision') }, [input.image]); }
      catch { fail('FACE_FAILED'); }
    });
  }
}

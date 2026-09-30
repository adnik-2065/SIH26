import { VisionDocumentResultSchema, type DocumentVisionAdapter } from '../documents';
import { newDetectorRuntime, readRuntimeSample, recordRuntime } from '../../metrics/timings';

export class OnnxDocumentAdapter implements DocumentVisionAdapter {
  private worker?: Worker;
  private cancel?: () => void;
  // The backend the worker chose and where its time went, for the run log.
  readonly runtime = newDetectorRuntime();
  constructor(private readonly timeoutMs = 90_000) {}
  dispose() { this.cancel?.(); this.worker?.terminate(); this.worker = undefined; }
  // Loads the model ahead of the first inspection, which reports any failure.
  warm() {
    try {
      this.worker ??= new Worker(chrome.runtime.getURL('vision/document.worker.js'));
      this.worker.postMessage({ type: 'warm', assetRoot: chrome.runtime.getURL('vision'), modelUrl: chrome.runtime.getURL('vision/document.onnx') });
    } catch { /* the next inspection creates the worker and reports its failure */ }
  }
  inspect(input: { observationId: string; image: ImageBitmap }, signal: AbortSignal) {
    if (signal.aborted || this.cancel) { input.image.close(); return Promise.reject(new Error(signal.aborted ? 'STOPPED' : 'VISION_BUSY')); }
    return new Promise<ReturnType<typeof VisionDocumentResultSchema.parse>>((resolve, reject) => {
      let worker: Worker;
      try { this.worker ??= new Worker(chrome.runtime.getURL('vision/document.worker.js')); worker = this.worker; }
      catch { input.image.close(); reject(new Error('VISION_FAILED')); return; }
      const cleanup = () => { clearTimeout(deadline); signal.removeEventListener('abort', abort); worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; this.cancel = undefined; input.image.close(); };
      const fail = (code: string) => { cleanup(); worker.terminate(); if (this.worker === worker) this.worker = undefined; reject(new Error(code)); };
      const abort = () => fail('STOPPED');
      const deadline = setTimeout(() => fail('VISION_TIMEOUT'), this.timeoutMs);
      this.cancel = abort; signal.addEventListener('abort', abort, { once: true });
      worker.onerror = () => fail('VISION_FAILED'); worker.onmessageerror = () => fail('VISION_FAILED');
      worker.onmessage = ({ data }) => {
        if (data?.type === 'error') { fail(data.code === 'MODEL_INVALID_RESULT' ? 'VISION_INVALID_RESULT' : 'VISION_FAILED'); return; }
        const result = VisionDocumentResultSchema.safeParse(data?.result);
        if (data?.type !== 'result' || !result.success || result.data.observationId !== input.observationId) { fail('VISION_INVALID_RESULT'); return; }
        const sample = readRuntimeSample(data.runtime);
        if (sample) recordRuntime(this.runtime, sample);
        cleanup(); resolve(result.data);
      };
      try { worker.postMessage({ observationId: input.observationId, image: input.image, assetRoot: chrome.runtime.getURL('vision'), modelUrl: chrome.runtime.getURL('vision/document.onnx') }, [input.image]); }
      catch { fail('VISION_FAILED'); }
    });
  }
}

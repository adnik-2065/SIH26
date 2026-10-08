import { createWorker, OEM, PSM, type Worker as OcrWorker } from 'tesseract.js';
import type { PerceptionInput } from '../contracts';
import { normalizeOcr } from './normalize';

// The panel owns this host. Terminating it also terminates its dedicated subworker,
// including during createWorker(), before Tesseract exposes a worker handle.
let engine: Promise<OcrWorker> | undefined;
let observationId = '';
self.onmessage = async (event: MessageEvent<PerceptionInput & { assetRoot: string }>) => {
  const input = event.data;
  observationId = input.observationId;
  const started = performance.now();
  const { width, height } = input.image;
  let canvas: OffscreenCanvas | undefined;
  try {
    engine ??= createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: `${input.assetRoot}/worker.min.js`, corePath: `${input.assetRoot}/core`,
      langPath: `${input.assetRoot}/lang`, workerBlobURL: false, cacheMethod: 'none',
      logger: message => self.postMessage({ type: 'progress', observationId, status: message.status, progress: message.progress }),
      errorHandler: () => self.postMessage({ type: 'error', observationId, code: 'OCR_WORKER_INIT_FAILED' }),
    }).then(async worker => {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      return worker;
    });
    const worker = await engine;
    canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('OCR_EXECUTION_FAILED');
    context.drawImage(input.image, 0, 0);
    input.image.close();
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    const result = normalizeOcr(data, observationId, width, height, performance.now() - started);
    self.postMessage({ type: 'result', result });
  } catch (error) {
    const code = error instanceof Error && error.message.startsWith('OCR_') ? error.message : 'OCR_EXECUTION_FAILED';
    self.postMessage({ type: 'error', observationId, code });
  } finally {
    input.image.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
};

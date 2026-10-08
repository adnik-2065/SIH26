import * as ort from 'onnxruntime-web/wasm';
import { ONNX_INPUT_SIZE, ONNX_MODEL_CLASSES, decodeOnnxOutput } from '../onnx-utils';

interface Input { observationId: string; image: ImageBitmap; assetRoot: string; modelUrl: string }
let session: ort.InferenceSession | undefined;

async function run(input: Input) {
  const started = performance.now();
  const width = input.image.width, height = input.image.height;
  let canvas: OffscreenCanvas | undefined;
  try {
    ort.env.wasm.wasmPaths = `${input.assetRoot}/`;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    session ??= await ort.InferenceSession.create(input.modelUrl, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    canvas = new OffscreenCanvas(ONNX_INPUT_SIZE, ONNX_INPUT_SIZE);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('MODEL_FAILED');
    const scale = Math.min(ONNX_INPUT_SIZE / width, ONNX_INPUT_SIZE / height);
    const resizedWidth = Math.max(1, Math.round(width * scale)), resizedHeight = Math.max(1, Math.round(height * scale));
    const padX = (ONNX_INPUT_SIZE - resizedWidth) / 2, padY = (ONNX_INPUT_SIZE - resizedHeight) / 2;
    context.fillStyle = '#727272'; context.fillRect(0, 0, ONNX_INPUT_SIZE, ONNX_INPUT_SIZE);
    context.drawImage(input.image, 0, 0, width, height, padX, padY, resizedWidth, resizedHeight);
    const pixels = context.getImageData(0, 0, ONNX_INPUT_SIZE, ONNX_INPUT_SIZE).data;
    const tensorData = new Float32Array(3 * ONNX_INPUT_SIZE * ONNX_INPUT_SIZE);
    const plane = ONNX_INPUT_SIZE * ONNX_INPUT_SIZE;
    for (let i = 0; i < plane; i++) {
      tensorData[i] = pixels[i * 4] / 255;
      tensorData[plane + i] = pixels[i * 4 + 1] / 255;
      tensorData[2 * plane + i] = pixels[i * 4 + 2] / 255;
    }
    const output = await session.run({ images: new ort.Tensor('float32', tensorData, [1, 3, ONNX_INPUT_SIZE, ONNX_INPUT_SIZE]) });
    const value = output[session.outputNames[0]];
    const tensor = value as { dims?: readonly number[]; data?: unknown };
    if (!tensor || !tensor.dims || tensor.dims.length !== 3 || tensor.dims[0] !== 1 || tensor.dims[1] !== 4 + ONNX_MODEL_CLASSES.length || !tensor.data || typeof (tensor.data as { length?: unknown }).length !== 'number') throw new Error('MODEL_INVALID_RESULT');
    const count = tensor.dims[2], data = tensor.data as Float32Array;
    return { observationId: input.observationId, truncated: false,
      detections: decodeOnnxOutput(data, count, width, height, scale, padX, padY).map(candidate => ({ type: candidate.category, source: 'vision_model' as const,
        confidence: candidate.confidence, bbox: candidate.bounds })), elapsedMs: performance.now() - started };
  } finally { if (canvas) { canvas.width = 0; canvas.height = 0; } }
}

self.onmessage = async ({ data }: MessageEvent<Input>) => {
  try { self.postMessage({ type: 'result', result: await run(data) }); }
  catch (error) { self.postMessage({ type: 'error', observationId: data?.observationId,
    code: error instanceof Error && /MODEL_INVALID_RESULT/.test(error.message) ? 'MODEL_INVALID_RESULT' : 'MODEL_FAILED' }); }
  finally { data?.image?.close(); }
};

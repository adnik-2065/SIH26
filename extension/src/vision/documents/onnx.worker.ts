import * as cpu from 'onnxruntime-web/wasm';
import * as gpu from 'onnxruntime-web/webgpu';
import { ONNX_INPUT_SIZE, ONNX_MODEL_CLASSES, decodeOnnxOutput } from '../onnx-utils';
import type { Backend, GpuAvailability } from '../../metrics/timings';

interface Input { observationId: string; image: ImageBitmap; assetRoot: string; modelUrl: string }
interface Model { ort: typeof cpu; session: cpu.InferenceSession; backend: Backend; loadMs: number }
interface GpuAdapter { info?: { isFallbackAdapter?: boolean }; isFallbackAdapter?: boolean }
let model: Promise<Model> | undefined;
let gpuFound: GpuAvailability = 'none';
// Set once a GPU session fails, so the worker stays on WASM from then on.
let gpuFailed = false;

// A software adapter (SwiftShader) is slower than the WASM path, so only a
// hardware adapter is used. Anything unusual falls back to WASM.
async function hardwareAdapter() {
  try {
    const adapter = await (navigator as Navigator & { gpu?: { requestAdapter(): Promise<GpuAdapter | null> } }).gpu?.requestAdapter();
    if (!adapter) { gpuFound = 'none'; return undefined; }
    const software = adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter ?? true;
    gpuFound = software ? 'software' : 'hardware';
    return software ? undefined : adapter;
  } catch { gpuFound = 'none'; return undefined; }
}

async function create(assetRoot: string, modelUrl: string): Promise<Model> {
  const started = performance.now();
  for (const ort of [cpu, gpu]) { ort.env.wasm.wasmPaths = `${assetRoot}/`; ort.env.wasm.proxy = false; }
  // Threads need a cross-origin isolated worker; without one the model runs on one.
  cpu.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor(navigator.hardwareConcurrency / 4))) : 1;
  // The GPU does the work, so its session keeps its CPU side to one thread and
  // leaves the cores to OCR.
  gpu.env.wasm.numThreads = 1;
  const adapter = gpuFailed ? undefined : await hardwareAdapter();
  if (adapter) {
    let session: cpu.InferenceSession | undefined;
    try {
      gpu.env.webgpu.adapter = adapter as typeof gpu.env.webgpu.adapter;
      session = await gpu.InferenceSession.create(modelUrl, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
      // The first run compiles the GPU shaders (about a second), so it happens
      // here, during the warm-up, rather than on the first screen.
      const size = ONNX_INPUT_SIZE;
      await session.run({ images: new gpu.Tensor('float32', new Float32Array(3 * size * size), [1, 3, size, size]) });
      return { ort: gpu as unknown as typeof cpu, session, backend: 'webgpu', loadMs: performance.now() - started };
    } catch { gpuFailed = true; session?.release().catch(() => {}); }
  }
  const session = await cpu.InferenceSession.create(modelUrl, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return { ort: cpu, session, backend: 'wasm', loadMs: performance.now() - started };
}

// One model per worker, shared by a warm-up and every inference. A failed load
// is forgotten, so the next request retries it and reports its failure.
function load(assetRoot: string, modelUrl: string) {
  if (model) return model;
  const created = model = create(assetRoot, modelUrl);
  created.catch(() => { if (model === created) model = undefined; });
  return created;
}

async function run(input: Input) {
  const started = performance.now();
  const width = input.image.width, height = input.image.height;
  let canvas: OffscreenCanvas | undefined;
  try {
    const waiting = performance.now();
    let loaded = await load(input.assetRoot, input.modelUrl);
    const waitMs = performance.now() - waiting;
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
    const inferring = performance.now();
    const infer = (current: Model) => current.session.run({ images: new current.ort.Tensor('float32', tensorData, [1, 3, ONNX_INPUT_SIZE, ONNX_INPUT_SIZE]) });
    let output;
    try { output = await infer(loaded); }
    catch (error) {
      // A GPU can fail mid-run (a lost device); the same input then runs on WASM.
      if (loaded.backend !== 'webgpu') throw error;
      gpuFailed = true; model = undefined;
      loaded.session.release().catch(() => {});
      loaded = await load(input.assetRoot, input.modelUrl);
      output = await infer(loaded);
    }
    const inferenceMs = performance.now() - inferring;
    const value = output[loaded.session.outputNames[0]];
    const tensor = value as { dims?: readonly number[]; data?: unknown };
    if (!tensor || !tensor.dims || tensor.dims.length !== 3 || tensor.dims[0] !== 1 || tensor.dims[1] !== 4 + ONNX_MODEL_CLASSES.length || !tensor.data || typeof (tensor.data as { length?: unknown }).length !== 'number') throw new Error('MODEL_INVALID_RESULT');
    const count = tensor.dims[2], data = tensor.data as Float32Array;
    const result = { observationId: input.observationId, truncated: false,
      detections: decodeOnnxOutput(data, count, width, height, scale, padX, padY).map(candidate => ({ type: candidate.category, source: 'vision_model' as const,
        confidence: candidate.confidence, bbox: candidate.bounds })), elapsedMs: performance.now() - started };
    return { result, runtime: { backend: loaded.backend, loadMs: loaded.loadMs, waitMs, inferenceMs, gpu: gpuFound } };
  } finally { if (canvas) { canvas.width = 0; canvas.height = 0; } }
}

self.onmessage = async ({ data }: MessageEvent<Input | { type: 'warm'; assetRoot: string; modelUrl: string }>) => {
  if ('type' in data) { load(data.assetRoot, data.modelUrl).catch(() => {}); return; }
  try { self.postMessage({ type: 'result', ...await run(data) }); }
  catch (error) { self.postMessage({ type: 'error', observationId: data?.observationId,
    code: error instanceof Error && /MODEL_INVALID_RESULT/.test(error.message) ? 'MODEL_INVALID_RESULT' : 'MODEL_FAILED' }); }
  finally { data?.image?.close(); }
};

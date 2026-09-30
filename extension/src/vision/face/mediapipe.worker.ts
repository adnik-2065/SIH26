import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import type { PerceptionInput } from '../contracts';
import { normalizeFaces } from './normalize';
import { faceTiles, mergeFaces } from './tiles';

let engine: Promise<FaceDetector> | undefined;
// How long the detector took to load, reported with every result.
let loadMs = 0;
const start = (assetRoot: string) => {
  if (engine) return engine;
  const loading = performance.now();
  engine = FilesetResolver.forVisionTasks(`${assetRoot}/wasm`).then(files => FaceDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: `${assetRoot}/blaze_face_short_range.tflite`, delegate: 'CPU' },
    runningMode: 'IMAGE', minDetectionConfidence: 0.5, minSuppressionThreshold: 0.3,
  })).then(detector => { loadMs = performance.now() - loading; return detector; });
  return engine;
};
self.onmessage = async ({ data: input }: MessageEvent<(PerceptionInput & { assetRoot: string }) | { type: 'warm'; assetRoot: string }>) => {
  if ('type' in input) {
    // A failed warm-up is forgotten, so the first inspection retries and reports it.
    const warming = start(input.assetRoot);
    warming.catch(() => { if (engine === warming) engine = undefined; });
    return;
  }
  const started = performance.now();
  const { width, height } = input.image;
  let canvas: OffscreenCanvas | undefined;
  try {
    const detector = await start(input.assetRoot);
    const waitMs = performance.now() - started;
    const result = normalizeFaces(detector.detect(input.image).detections, input.observationId, width, height, 0);
    for (const tile of faceTiles(width, height)) {
      canvas ??= new OffscreenCanvas(tile.width, tile.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('FACE_FAILED');
      context.drawImage(input.image, tile.x, tile.y, tile.width, tile.height, 0, 0, tile.width, tile.height);
      const local = normalizeFaces(detector.detect(canvas).detections, input.observationId, tile.width, tile.height, 0);
      result.regions.push(...local.regions.map(region => ({ ...region, bounds: { ...region.bounds, x: region.bounds.x + tile.x, y: region.bounds.y + tile.y } })));
    }
    result.regions = mergeFaces(result.regions);
    result.elapsedMs = performance.now() - started;
    self.postMessage({ type: 'result', result, runtime: { backend: 'wasm', loadMs, waitMs, inferenceMs: result.elapsedMs - waitMs } });
  } catch {
    // Do not forward library errors, which may include input or environment data.
    self.postMessage({ type: 'error', observationId: input.observationId });
  } finally {
    input.image.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
};

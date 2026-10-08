import { build } from 'vite';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zodToJsonSchema } from 'zod-to-json-schema';
import './openredaction.mjs';

await build({ configFile: false, build: {
  outDir: 'dist', emptyOutDir: true,
  rollupOptions: { input: 'panel.html' },
}, worker: { format: 'es' } });
await build({ configFile: false, build: {
  outDir: 'dist', emptyOutDir: false,
  lib: { entry: 'src/background/index.ts', formats: ['es'], fileName: () => 'background.js' },
} });
await build({ configFile: false, build: {
  outDir: 'dist', emptyOutDir: false,
  lib: { entry: 'src/dom/content.ts', formats: ['iife'], name: 'SIH26Observer', fileName: () => 'content.js' },
} });
// Single source of truth for the backend endpoint: `src/backend.json`.
// The shipped manifest is GENERATED from that one value here, so
// `host_permissions` and `connect-src` can never drift from the runtime
// transport in `src/config.ts` (which reads the same file). Changing the
// backend URL is a one-file edit plus a rebuild.
{
  const backendDefaults = JSON.parse(await readFile('src/backend.json', 'utf8'));
  const base = (process.env.VITE_AGENT_BASE_URL || backendDefaults.baseUrl).replace(/\/+$/, '');
  const route = backendDefaults.route || '/agent';
  const backendEndpoint = `${base}${route}`;
  const origin = new URL(base).origin;
  const allowed = new URL(base).protocol === 'https:' ||
    (new URL(base).protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname));
  if (!allowed) {
    console.error(`\nBACKEND_ENDPOINT_INVALID: ${base} is not an https URL (or http on localhost).\n`);
    process.exit(1);
  }
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  // Host permissions are regenerated as exactly the one backend origin;
  // extra origins belong in src/backend.json-driven code, not hand-edits.
  manifest.host_permissions = [`${origin}/*`];
  // connect-src is regenerated as exactly `self` + the one backend origin;
  // any stale origin from a previous endpoint is dropped automatically.
  const cspParts = (manifest.content_security_policy?.extension_pages ?? '')
    .split(';').map((part) => part.trim()).filter(Boolean);
  const connectIdx = cspParts.findIndex((part) => part.startsWith('connect-src'));
  const connectSrc = `connect-src 'self' ${origin}`;
  if (connectIdx < 0) cspParts.push(connectSrc);
  else cspParts[connectIdx] = connectSrc;
  manifest.content_security_policy = { ...manifest.content_security_policy, extension_pages: cspParts.join('; ') };
  await writeFile('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest.json generated for agent endpoint: ${backendEndpoint}`);
}
await cp('manifest.json', 'dist/manifest.json');
await mkdir('dist/licenses', { recursive: true });
await cp('vendor/openredaction/LICENSE', 'dist/licenses/OPENREDACTION-LICENSE');
await cp('../tests/fixtures/assets', 'dist/fixtures', { recursive: true });
// Ship OCR code and English data with the extension; runtime never uses a CDN.
await mkdir('dist/ocr/core', { recursive: true });
await mkdir('dist/ocr/lang', { recursive: true });
await cp('node_modules/tesseract.js/dist/worker.min.js', 'dist/ocr/worker.min.js');
for (const file of await readdir('node_modules/tesseract.js-core')) {
  if (/-lstm\.wasm(?:\.js)?$/.test(file)) await cp(`node_modules/tesseract.js-core/${file}`, `dist/ocr/core/${file}`);
}
await cp('node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz', 'dist/ocr/lang/eng.traineddata.gz');
await cp('node_modules/tesseract.js/LICENSE.md', 'dist/ocr/TESSERACT-LICENSE.md');
await cp('node_modules/tesseract.js-core/LICENSE', 'dist/ocr/core/LICENSE');
// Local, pinned MediaPipe runtime and model. No network access during build/run.
const faceModel = 'assets/mediapipe/blaze_face_short_range.tflite';
if (createHash('sha256').update(await readFile(faceModel)).digest('hex') !== 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f') throw new Error('Face model checksum mismatch');
await build({ configFile: false, build: {
  outDir: 'dist/vision', emptyOutDir: false,
  lib: { entry: 'src/vision/face/mediapipe.worker.ts', formats: ['iife'], name: 'SIH26FaceWorker', fileName: () => 'face.worker.js' },
} });
await cp('node_modules/@mediapipe/tasks-vision/wasm', 'dist/vision/wasm', { recursive: true });
await cp(faceModel, 'dist/vision/blaze_face_short_range.tflite');
await cp('assets/mediapipe/README.md', 'dist/vision/README.md');
await cp('assets/mediapipe/LICENSE', 'dist/vision/LICENSE');
// Local document/privacy detector. The artifact is the supplied Ultralytics
// ONNX export; inference and post-processing run entirely inside a worker.
const documentModel = '../models/best.onnx';
if (createHash('sha256').update(await readFile(documentModel)).digest('hex') !== 'cef9f1d18e6dd3e56341a2828fc71b2d7b0e13298f7cc74c835d9d76ababbda3') throw new Error('Document model checksum mismatch');
await build({ configFile: false, build: {
  outDir: 'dist/vision', emptyOutDir: false,
  define: { 'import.meta.url': 'self.location.href' },
  rollupOptions: { input: 'src/vision/documents/onnx.worker.ts', output: { format: 'es', entryFileNames: 'document.worker.js' } },
} });
// The ORT browser bundle contains an import.meta URL probe even though this
// extension uses a classic worker. Replace that probe with the worker URL so
// the bundled worker remains compatible with Chrome's extension worker loader.
const documentWorkerPath = 'dist/vision/document.worker.js';
await writeFile(documentWorkerPath, (await readFile(documentWorkerPath, 'utf8')).replaceAll('import.meta.url', 'self.location.href'));
await cp(documentModel, 'dist/vision/document.onnx');
await cp('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'dist/vision/ort-wasm-simd-threaded.wasm');
await cp('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'dist/vision/ort-wasm-simd-threaded.mjs');
await cp('assets/onnxruntime/LICENSE', 'dist/licenses/ONNXRUNTIME-LICENSE');
await cp('../models/README.md', 'dist/vision/DOCUMENT-MODEL.md');
// Generate the future Python-compatible protocol from the same runtime schemas.
await build({ configFile: false, build: { outDir: 'dist/contracts', emptyOutDir: true,
  lib: { entry: 'src/contracts.ts', formats: ['es'], fileName: () => 'contracts.mjs' },
} });
const contracts = await import(new URL('../dist/contracts/contracts.mjs', import.meta.url));
for (const name of ['ActionResponseSchema', 'StepRequestSchema']) {
  await writeFile(`dist/contracts/${name}.json`, JSON.stringify(zodToJsonSchema(contracts[name], name), null, 2) + '\n');
}

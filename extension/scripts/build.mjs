import { build } from 'vite';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zodToJsonSchema } from 'zod-to-json-schema';

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
await cp('manifest.json', 'dist/manifest.json');
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
// Generate the future Python-compatible protocol from the same runtime schemas.
await build({ configFile: false, build: { outDir: 'dist/contracts', emptyOutDir: true,
  lib: { entry: 'src/contracts.ts', formats: ['es'], fileName: () => 'contracts.mjs' },
} });
const contracts = await import(new URL('../dist/contracts/contracts.mjs', import.meta.url));
for (const name of ['ActionResponseSchema', 'StepRequestSchema']) {
  await writeFile(`dist/contracts/${name}.json`, JSON.stringify(zodToJsonSchema(contracts[name], name), null, 2) + '\n');
}

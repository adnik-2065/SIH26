# Local OCR milestone — 2026-09-08

The project owner explicitly authorized Tesseract OCR and a clearer extension UI after the original Phase 1 handoff. This supersedes the earlier exclusion of real OCR. Sensitive-data detection, redaction, face detection, model training, AI/planner integration, and browser actions remain outside this change.

## Implemented flow

Visible-tab screenshot → ImageBitmap → reusable Tesseract.js English worker → real word text/confidence/pixel boxes → validated `PerceptionResult` → screenshot overlay and detected-word list.

The extension already had `tesseract.js` 7.0.0 and `@tesseract.js-data/eng` 1.0.0 in its package and lockfile when this implementation started. The build now packages the runtime worker, the LSTM core variants (plain, SIMD, relaxed SIMD), and English trained data. The manifest permits WebAssembly through `wasm-unsafe-eval`, retains `connect-src 'self'`, and adds no host or Chrome API permissions. `workerBlobURL: false` avoids blob worker permissions. Language caching is disabled; assets load from the extension package.

The adapter lives in `extension/src/vision/ocr/tesseract.ts`. A panel-owned module worker hosts Tesseract's dedicated subworker. Successful scans reuse the initialized engine; cancellation/error/timeout terminates the host and its child, including during initialization. A later scan creates a fresh worker. The panel also disposes it on Stop, preview opt-out, pagehide, and unmount. No offscreen document or service-worker inference is needed because processing lasts only while the panel is open.

The host requests `blocks: true` explicitly and uses `PSM.SPARSE_TEXT` for scattered webpage text. It does not resize, crop, or rotate the image. `normalize.ts` converts `bbox` corners into x/y/width/height and confidence from 0–100 to the contract's 0–1 range. `source: 'model'` means real OCR under the existing contract; it does not mean a planner or privacy clearance. Empty output is a valid result. Missing layouts, invalid/out-of-image bounds, and output over 500 words fail explicitly, without silently dropping regions.

The panel checks observation ID, generation, cancellation, and preview state before accepting results. Starting a new capture clears prior results. Page/tab changes clear stale results and abort work in progress. Timeouts stop recognition after 90 seconds. Retry can process the still-current screenshot after an OCR failure. Images and text stay in memory, never extension storage or operational logs. Tesseract's reusable engine has an in-memory working set until reused or terminated; reference cleanup is not a claim of physical memory erasure.

## UI and manual verification

1. Build, reload `extension/dist/` in Chrome, and open the fixture server at `http://127.0.0.1:4173/`.
2. Click the extension toolbar icon on the fixture tab to grant temporary access.
3. Select **Start observation** with **Read text and show screenshot** enabled (the default). The optional note does not change OCR behavior.
4. Watch capture/loading/recognition progress, then inspect **Detected text**. The fixture includes `student@example.test` in a field placeholder and inside an image.
5. Purple boxes represent actual OCR words. Select a word to highlight its box and inspect its confidence and original-image pixel coordinates. **Full size** enables a scrollable preview at native resolution. **Page controls** enables the independent green/orange DOM overlay.
6. Zoom or scroll the webpage and use **Observe again**. Its previous capture becomes invalid.
7. Stop during OCR, then start again. No previous result should reappear. Turning off the preview also clears data and terminates the worker.

Screenshots remain original and unredacted. English OCR may miss small, low-contrast, stylized, or overlapping text; it may split email addresses into multiple adjacent words. Confidence is an engine estimate, not a calibrated probability. Recognition is limited to the visible screenshot and 500 words. This is a working OCR milestone, not an accuracy benchmark across websites or languages.

## Verification

On 2026-09-08, the production build, TypeScript, ESLint, 36 unit tests, and all 7 Chromium browser tests passed. The 380-pixel panel and OCR overlay were visually inspected. One illustrative first scan read 96 words in about 2.0 seconds including initialization; this is not an accuracy or performance benchmark. See `project-context.md` for artifacts and scope. The suite covers normalization and worker lifecycle, real OCR from image-only fixture content (including changed pixels absent from DOM text), original-image box alignment at 100%/125% zoom, worker reuse, invalidation, Stop, restart after Stop, preview opt-out, and extension storage/external-request checks. Browser artifacts contain synthetic fixture data only and are written under `/tmp`.

Implementation references: [Tesseract API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md), [local assets](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md). The installed v7 source was inspected for current core variants and output handling.

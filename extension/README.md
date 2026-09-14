# Local page observation, OCR, and face detection

Chrome Manifest V3 extension with a React side panel. Captures the full scrollable page, reads English screenshot text with Tesseract.js, and locates faces with MediaPipe BlazeFace. Both run locally in workers and return confidence and original-image pixel bounds through `src/vision/contracts.ts`.

From this directory, with Node.js 20.19 or newer:

```bash
npm ci
npm run build
npm run fixtures
```

Load `extension/dist/` unpacked in Chrome. Open **http://127.0.0.1:4173/** and click the extension toolbar icon. Select **Scan current page**. Local text and face analysis is enabled by default in **Scan settings**. Review purple text boxes and pink face boxes using the **Text** and **Faces** result tabs. Select a result to highlight it; use **Full size** for pixel inspection. **Controls** shows the separate DOM overlay.

**Scan again** captures a fresh view. **Stop**, disabling local analysis, and closing the panel terminate both detector workers and release their data. Page changes invalidate results and cancel running detection. The optional observation note stays local and does not direct OCR.

Full-page scans use one native Chrome screenshot with the existing layout dimensions held steady, without scrolling the webpage. This requires the `debugger` permission; after reloading the extension, Chrome may ask you to accept that permission and show its temporary debugging notice during capture. The extension detaches after capture, including on Stop or errors. It never falls back to scrolling the live page. OCR and face detection process overlapping sections with reused local workers and publish results as each section finishes. Bounding boxes remain in full-image coordinates.

In visible Chrome/Brave windows, native capture can temporarily hide the page scrollbar and shift centered content. Capture now reserves that existing scrollbar space with a temporary stylesheet, then removes it on success, Stop, or failure. It leaves the site's inline styles untouched and skips pages with overlay scrollbars or an already-reserved gutter. Real page changes still invalidate a scan.

Capture covers the current rendered document, including content below the viewport. Native lazy images are decoded before capture without scrolling and their loading attributes are restored. It does not navigate pagination or trigger custom infinite-scroll/data-src loaders. Captures are limited to 32 million pixels and 32,767 pixels per side, with an explicit error rather than a cropped result. These limits keep large pages from allocating unbounded image buffers. The 500-result validation limit applies to each detector section, not to the combined page results.

Checks:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

The browser suite includes `real-panel.spec.ts`, which clicks buttons in the actual native side panel (not a normal tab displaying the panel HTML). It verifies text and faces, rescans, below-the-fold lazy images, scroll/focus preservation, Stop/cleanup, and recovery at 100% and 125% zoom. Run it in a visible window as well: headless browsers can use overlay scrollbars and miss classic-scrollbar regressions.

```bash
SIH26_HEADED=1 npx playwright test real-panel.spec.ts
# Optional: use an installed Brave binary; adjust the path for your system.
SIH26_BROWSER_PATH=/opt/brave.com/brave/brave SIH26_HEADED=1 npx playwright test real-panel.spec.ts
```

These tests use isolated temporary browser profiles and the synthetic local fixture, not your normal browser profile or live faculty website.

Dependencies and the test browser are downloaded during setup. OCR code, WebAssembly variants, and English language data are bundled into `dist/ocr/` (approximately 30 MB); the running extension loads them from its own origin. MediaPipe runtime/WASM and the checksum-verified face model are bundled into `dist/vision/` (approximately 35 MB). There is no runtime CDN dependency, backend, text PII classification, document detection, redaction, or planner integration. Face boxes locate faces; they do not remove pixels or prove a page is safe.

Rebuild and reload the extension after source changes. See [MediaPipe and future model/payload guide](../docs/mediapipe.md) for face detection and the next integration steps, [OCR implementation notes](../docs/ocr.md) for design, limitations, and verification, and [Phase 1 notes](../docs/phase-one.md) for the original foundation.

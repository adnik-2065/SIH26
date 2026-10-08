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

Full-page scans use native Chrome captures with the existing layout dimensions held steady, without scrolling the webpage. Ordinary pages use one image; long pages use overlapping images at the original resolution, delivered separately to the panel. Capture progress appears in the existing scan area. The preview remains one continuous view, with offscreen image buffers released as you scroll. This requires the `debugger` permission; after reloading the extension, Chrome may ask you to accept that permission and show its temporary debugging notice during capture. The extension detaches after capture, including on Stop or errors. It never falls back to scrolling the live page. OCR and face detection process overlapping sections with reused local workers and publish results as each section finishes. Bounding boxes remain in full-image coordinates.

In visible Chrome/Brave windows, native capture can temporarily hide the page scrollbar and shift centered content. Capture now reserves that existing scrollbar space with a temporary stylesheet, then removes it on success, Stop, or failure. It leaves the site's inline styles untouched and skips pages with overlay scrollbars or an already-reserved gutter. CSS animations are temporarily paused and transitions disabled so Chrome's capture layout cannot start responsive animations between images; the stylesheet is removed on success, Stop, and errors. Input, scrolling, resizing, and DOM mutations still invalidate a scan.

Capture covers the current rendered document, including content below the viewport. Native lazy images are decoded before capture without scrolling and their loading attributes are restored. It does not navigate pagination or trigger custom infinite-scroll/data-src loaders. The 32-million-pixel and 32,767-pixel limits apply to individual images, not the full page. Larger pages are captured in bounded images of at most 8 million pixels, then decoded and analyzed one at a time per detector. Overlap preserves text and faces across image boundaries without duplicate results. A scan retains at most 128 MB of encoded screenshots and 2,048 images; exceeding these resource limits produces an explicit error rather than a cropped result. The 500-result validation limit applies to each detector section, not to the combined page results.

Checks:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

The browser suite includes `real-panel.spec.ts`, which clicks buttons in the actual native side panel (not a normal tab displaying the panel HTML). It verifies text and faces, rescans, lazy images at the end of a page over 37,000 pixels tall, scroll/focus preservation, Stop/cleanup, and recovery at 100% and 125% zoom. Run it in a visible window as well: headless browsers can use overlay scrollbars and miss classic-scrollbar regressions.

```bash
SIH26_HEADED=1 npx playwright test real-panel.spec.ts
# Optional: use an installed Brave binary; adjust the path for your system.
SIH26_BROWSER_PATH=/opt/brave.com/brave/brave SIH26_HEADED=1 npx playwright test real-panel.spec.ts
```

These tests use isolated temporary browser profiles and the synthetic local fixture, not your normal browser profile or live faculty website.

The supplied local ONNX document model is bundled and runs in a worker; its four classes cover identity documents, fingerprints, signatures, and financial documents. Detection can miss content and conservative rules can over-redact. See [the incremental privacy report](../docs/privacy-enhancements.md) for scope and limitations.

Rebuild and reload the extension after source changes. See [MediaPipe and future model/payload guide](../docs/mediapipe.md) for face detection and the next integration steps, [OCR implementation notes](../docs/ocr.md) for design, limitations, and verification, and [Phase 1 notes](../docs/phase-one.md) for the original foundation.

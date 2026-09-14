# Phase 1 — Setup, implementation, and handoff

**Historical Phase 1 baseline:** Real Tesseract OCR and a redesigned panel were added on 2026-09-08 at the project owner’s request. See [current OCR setup and behavior](ocr.md). The mock-only scope, UI labels, and test counts below describe the earlier deliverable.

This document describes the implemented Phase 1 foundation. The original architecture and development documents remain planning references and have not been rewritten.

## Agreed scope

The project owner explicitly excluded training and real model integration from this implementation. The perception work in PH1-07 is therefore limited to a typed adapter interface and a clearly labelled synthetic mock worker. Another member will supply real OCR/vision. There are no model dependencies, weights, download scripts, real inference, or accuracy claims in this implementation.

The extension observes one user-invoked HTTP(S) tab locally. It does not fill, click, submit, redact, or call a backend. These are later-phase responsibilities. The six action schemas define the future contract only; no executor is registered.

## Implemented issue mapping

| Issue | Implemented foundation |
| --- | --- |
| PH1-01 | Manifest V3, React/TypeScript side panel, Vite builds for UI/service worker/content script, npm lockfile, build/type/lint commands |
| PH1-02 | Synthetic application portal, manual validation/submission, submission counter, hidden/disabled/delayed fields, layout toggle, image-only text and generated fictional portrait |
| PH1-03 | Strict runtime schemas for messages, observations, action proposals, and a separate future sanitized request; generated JSON Schema for future Python compatibility |
| PH1-04 | One task/tab/origin, Start/Observe again/Stop, statuses, generation-based cancellation, tab/navigation invalidation, restart recovery |
| PH1-05 | Visible DOM controls, labels/roles/types/bounds, disabled-state detection, observation-scoped local element references; field values excluded |
| PH1-06 | Local visible screenshot, before/after DOM consistency checks, active-tab checks, viewport/scale metadata, opt-in numbered overlay and capture timings |
| PH1-07 | Adapter interface, output validation, fixture-only worker, abort/deadline handling. Real OCR/vision and hardware compatibility benchmarking deferred by explicit request |
| PH1-08 | Contract/cancellation/capture/timing unit tests, browser tests, metadata-only timing summary, synthetic browser baseline |
| PH1-09 | Reproducible setup, hardware-report script, troubleshooting, limitations, and teammate handoff |

## Setup

Use Node.js 20.19 or newer and npm. Browser use requires Chrome with the Side Panel API (manifest minimum: Chrome 116); browser automation uses the Chromium revision installed by the pinned Playwright package.

From the project directory:

```bash
cd extension
npm ci
npm run build
npm run fixtures
```

The fixture server binds only to `127.0.0.1:4173`. Leave that terminal running during manual testing.

1. Open `chrome://extensions` in Chrome.
2. Enable Developer mode.
3. Choose **Load unpacked**, selecting the generated `SIH26/extension/dist/` directory.
4. Open `http://127.0.0.1:4173/`.
5. Click this extension's toolbar icon on that page. This grants temporary `activeTab` access and opens the panel. The configured shortcut is Ctrl+Shift+Y if it is available in your browser.
6. Enter a task description. In Phase 1 it labels the intended task in the panel; it is not sent to a planner.
7. Optionally check **Show local screenshot and element labels**, then select **Start observation**.
8. Inspect the numbered screenshot and control list. Orange boxes indicate disabled controls.
9. Change the fixture layout, edit a field, or scroll. The previous observation is invalidated. Select **Observe again** for fresh data.
10. Select **Stop** to invalidate work and clear the panel's captured data and task text.

To test form behavior, fill the fixture manually. Submission stays local and increments the displayed counter. The extension does not automate the form.

After editing code:

```bash
npm run build
```

Reload the extension in `chrome://extensions`, reload the test page, and invoke the toolbar icon again. No development server or CDN script is loaded by the extension.

## Code layout

```text
extension/
  manifest.json             Permissions and extension entry points
  panel.html                Side panel document
  src/contracts.ts          Authoritative runtime and protocol schemas
  src/ui/                   Panel, opt-in preview, controls, local state
  src/background/           Chrome coordination, session lifecycle
  src/dom/                  Content script, observation, local element map
  src/capture/              Screenshot and consistency checks
  src/agent/lifecycle.ts     Generation checks and restart handling
  src/vision/               Perception contract and mock-only worker
  src/metrics/              Timing summary helpers
  scripts/                  Build, local fixture server, hardware report
  tests/unit/               Runtime contract and cancellation checks
  tests/browser/            Isolated Chromium integration checks
tests/fixtures/             Synthetic portal and image assets
```

Existing backend, privacy, and other later-phase placeholder folders remain untouched.

## Contracts and observation validity

`src/contracts.ts` is the source of truth. Schemas reject unknown keys and unsupported action types. The build emits `dist/contracts/ActionResponseSchema.json` and `dist/contracts/StepRequestSchema.json` for the future Python backend; do not hand-edit generated schemas.

An observation includes its ID, document ID, revision, origin, viewport/scroll/scale metadata, and relevant controls. The screenshot and DOM are collected separately. The capture process compares before/after snapshots and checks that the same tab remains active. Changes cause invalidation or a controlled capture failure rather than an automatic action.

References belong to one observation and remain in the content script. Input/change/scroll/resize/navigation and DOM mutation events clear them. There is no unrestricted READ or execute-script action exposed to a planner.

Stop increments the task generation. Results from earlier generations cannot replace current state. Necessary task metadata is held in extension-only `chrome.storage.session`. A service-worker restart pauses an unfinished task, discards observation validity, and requires re-observation. It does not resume capture automatically.

The current observer is conservative. It is not an atomic screenshot of arbitrary animated pages. CSS-only changes between checks, canvas/video contents, cross-origin frames, closed shadow roots, browser dialogs, and full-page capture are outside the verified scope. Hidden/offscreen controls are counted and omitted; at most 200 visible controls from 2,000 candidates are returned. Unsupported or unstable cases need manual handling.

## Data handling in Phase 1

- No external host permissions, AI requests, telemetry endpoints, or backend configuration.
- The content security policy restricts extension connections to its own origin.
- DOM input values, selectors, raw HTML, and credentials are not collected into the control descriptions. Labels are unredacted local content.
- Original screenshots are temporarily decoded in memory. Decoded bitmaps are closed after dimensions are read.
- The panel retains an observation only when its local preview is enabled. Disabling preview, invalidation, Stop, or closing the panel releases it.
- Screenshots, task instructions, and labels are not written to extension storage or operational logs. Session storage contains necessary task metadata only.
- Clearing references permits memory reclamation; it does not claim immediate physical memory erasure.
- The synthetic browser test may write its own fixture screenshot and timing record under the OS temporary directory for verification.

## Perception handoff to the other member

Start with `src/vision/contracts.ts`. A `PerceptionAdapter` implements:

```typescript
inspect(input: PerceptionInput, signal: AbortSignal): Promise<PerceptionResult>
```

Input contains an observation ID and an `ImageBitmap`. The adapter takes ownership of the bitmap and must close it when no longer needed, including errors/cancellation. Results contain the matching observation ID, a source (`mock` or `model`), region kinds, pixel bounds in the original input image's coordinates, optional text/confidence, and elapsed time. A completed result is not permission to export anything.

`MockPerceptionAdapter` accepts only the known `synthetic-details` fixture. Its worker returns one predetermined email-text region after a short simulated delay. It does not inspect pixels, perform OCR, detect faces, or represent model performance. The panel uses only the packaged fixture for this button; page screenshots are not routed to it.

The teammate should add a separate real adapter, preserve result validation, handle cancellation and resource cleanup, and return `source: 'model'` only after real processing. Workers can be hosted by an extension document. The current panel hosts the mock worker; an offscreen host is a later integration decision if real processing needs to outlive the panel. Runtime/WASM permissions and model assets should be introduced with that work, after compatibility and license checks.

No real-model choice, training, weights, preprocessing, acceleration/fallback implementation, or model resource benchmark has been performed here.

## Verification commands

From `extension/`:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run hardware
```

For an isolated browser download location, set `PLAYWRIGHT_BROWSERS_PATH` to the same directory for both installation and test execution. Browser tests require permission to open the local fixture port and launch Chromium. They use a temporary browser profile, not your personal Chrome profile.

`npm run hardware` reports OS/CPU/RAM/free disk/Node without reading secrets. Run it separately on both laptops. GPU and VRAM must be recorded using browser/OS profiling tools. Laptop 2 information is not available from Laptop 1.

## Recorded verification — 2026-09-07

- Production build, TypeScript checks, and ESLint: passed.
- Unit tests: 28 passed, covering strict contracts, cancellation/restart state, capture consistency, screenshot-size mismatches, and timing summaries.
- Browser tests: 5 passed using Chrome for Testing 153.0.8010.12 with the production manifest unchanged. The harness triggers the toolbar action through browser-level CDP to grant temporary `activeTab` access.
- Browser coverage: panel and mock worker; manual fixture validation/submission; DOM plus screenshot; 100%/125% zoom and scrolling; page-change invalidation; Stop; no external HTTP(S) requests observed by the test context; no screenshots, task instructions, or fixture values in inspected extension storage.
- The synthetic screenshot overlay was visually inspected and its numbered boxes aligned with the controls. The harness uses a native viewport, because fixed device emulation can differ from Chrome's native tab capture dimensions. The extension rejects inconsistent dimensions.
- One illustrative baseline capture: 11 visible controls, DOM collection 3.5 ms, native screenshot capture 61.2 ms, viewport 1280 × 913 CSS pixels at device pixel ratio 1. This is one sample, not a performance target or distribution.
- Test environment: Linux x64, Intel Core i7-13620H, 16 logical CPU cores, approximately 15.31 GiB RAM, Node 20.20.0. These describe the available development machine; Laptop 2, GPU/VRAM, and real-model performance remain unmeasured.
- Real OCR/vision was intentionally not tested or implemented. The mock's simulated delay is not an inference benchmark. Automated tests use an isolated headless browser; a manual check in the team's installed Chrome is still useful for OS-specific toolbar/shortcut behavior.

## Troubleshooting

| Problem | Next step |
| --- | --- |
| Access required or capture failure | Open an HTTP(S) page and click the extension icon on that tab; a previously open panel does not grant access to another website |
| Page changed notice | Let the page settle, keep its tab active, and select Observe again |
| No screenshot shown | Enable the local preview and observe again; previous screenshots are deliberately not retained for later retrieval |
| Background restarted notice | Observe again; the previous observation cannot be reused |
| Mock worker fails | Rebuild, reload the extension, and retry; no model installation is needed |
| Fixture port already in use | Stop the earlier fixture server or inspect the process using port 4173 |
| Browser test executable missing | Run `npx playwright install chromium` using the same browser-path environment as the test |

References: [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [side panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel), [service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers).

# SIH26 — Project context and conversation handoff

**Last updated:** 2026-09-09, Asia/Kolkata.  
**Current stage:** Phase 1 foundation, local Tesseract OCR, MediaPipe face detection, the fail-closed redaction pipeline, the supplied ONNX document detector, and an end-to-end round against the hosted reasoning server: observe → detect → redact → send → translate → perform one step.
**Purpose:** Give a new collaborator or conversation enough context to continue without mistaking plans or mock results for completed features.

This is a dated handoff, not a substitute for inspecting current code. Read this file first, then check the relevant source files and `git status` before making changes. Tests reported here were run during the prior implementation, not rerun merely to create this document.

## Current MediaPipe update — 2026-09-09

The user authorized MediaPipe now, a substantial SaaS-style panel redesign, and explanations of future trained-model integration, preprocessing/redaction, and the final payload. Their The supplied ONNX document model is now bundled and integrated; broader model coverage remains future work. No privacy gateway, backend, or execution work was requested or implemented.

- **Implemented:** `extension/src/vision/face/{mediapipe.ts,mediapipe.worker.ts,normalize.ts}` runs real MediaPipe BlazeFace alongside existing OCR. Separate bitmaps/workers; original-image face bounds and confidence; no identity recognition.
- **Packaging:** pinned `@mediapipe/tasks-vision` 1.0.1 and BlazeFace short-range float16 v1 weights. Build verifies SHA-256 and bundles WASM/model/worker under `dist/vision` (~35 MB). No runtime CDN or new permission/CSP changes.
- **Lifecycle:** reusable face worker, 30-second deadline, cancellation/error termination, stale-result rejection, independent OCR/face error states, retry, Stop/opt-out/panel-close disposal.
- **UI:** workflow view with Capture → Detect → Review, per-engine status, primary scan action, settings, searchable text and face tabs, selectable boxes, layer toggles, and explicit unredacted/planned-feature status. New labels supersede prior UI instructions below.
- **Document model integration:** `src/vision/documents/onnx.ts` runs the supplied `models/best.onnx` through ONNX Runtime Web in a local worker. `models/README.md` records classes, checksum, and licensing. No outgoing network payload exists today. - **Verification (2026-09-09):** production build, TypeScript, lint, 46 unit tests, and 9 Chromium browser tests passed. Real face localization on the fictional portrait at 100%/125% zoom; zero faces after replacing portrait pixels with white; selection/search; worker reuse and Stop/opt-out cleanup; missing model simulation with incomplete status and successful retry. No external HTTP(S) requests or page errors observed. The 380-pixel panel was visually checked. Synthetic UI artifact: `/tmp/sih26-vision-panel.png`. The documented payload example was parsed successfully by the generated `StepRequestSchema`.

### Wide-screenshot face detection fix — 2026-09-09

A user reported a missed fixture portrait in a 1373 × 999 capture. The previous whole-image pass was scale-sensitive; a regression at that size also exposed a loose, inaccurately localized box. The face worker now runs the full image plus up to 25 overlapping crops, translates crop boxes back to screenshot pixels, and suppresses overlapping/near-contained duplicates by confidence. No threshold, UI, permission, OCR, or fixture changes were needed. See `extension/src/vision/face/tiles.ts`.

Verification after this fix: build, TypeScript, lint, 55 unit tests, and 13 Chromium browser tests passed. New real-inference tests find exactly one correctly positioned face at 1373 × 999, 1920 × 1080, DPR 2 (2746 × 1998 pixels), and across a crop boundary. Existing empty-face, zoom, cancellation, reuse, and model-failure/retry checks still pass. The generated `extension/dist` is rebuilt; an already-loaded extension must be reloaded to use it.

The OCR entry and Phase 1 sections below are historical where they exclude face detection. See the new guide and current source for the current implementation.

## Current OCR update — 2026-09-08

The user explicitly authorized implementing real Tesseract OCR and improving the extension UI. This changes the earlier model-work ownership boundary **for OCR only**. The historical Phase 1 narrative below must not be read as excluding or mocking the new OCR implementation.

- **Implemented:** screenshot pixels → Tesseract.js English → word text, confidence, original-image bounds → existing `vision/contracts.ts` → selectable purple screenshot boxes and detected-word list.
- **Files:** `extension/src/vision/ocr/{tesseract.ts,tesseract.worker.ts,normalize.ts}`; redesigned `src/ui/main.tsx` and `styles.css`; local OCR packaging in `scripts/build.mjs`; WebAssembly CSP permission in `manifest.json`.
- **Runtime:** one reusable engine hosted by the panel; cancellation/error/timeout terminates its worker tree, with fresh initialization on the next scan. Observation identity and generation checks reject stale results. Stop and preview opt-out clear data and dispose the worker.
- **Assets:** existing pinned Tesseract 7.0.0 and English data 1.0.0 are bundled into the extension (about 30 MB). No runtime CDN, external connection, or additional host/API permission. `connect-src 'self'` remains.
- **UI:** “Page text reader”; preview/OCR enabled by default; optional local observation note; capture/read/review steps, progress, errors/retry, word confidence/coordinates, full-size preview, and separate DOM overlay. The mock demo button is removed; mock source files remain as legacy interface examples.
- **Limits:** English, visible viewport, 500 words, 90-second deadline. Small text may be split or misread; confidence is only an engine estimate. Images remain unredacted. No sensitive-data detection, face detection, training, AI, or browser action implementation.
- **Verification (2026-09-08):** build, TypeScript, and lint passed; 36 unit tests and 7 Chromium browser tests passed. Browser coverage includes actual image-only OCR, changed pixels absent from DOM text, reuse, 100%/125% coordinate alignment, scroll/page invalidation, Stop during OCR, restart after Stop, and preview opt-out. No external HTTP(S) requests were observed; inspected extension storage contained no screenshots or fixture OCR text. The 380-pixel panel and purple OCR overlay were visually checked. One illustrative first scan read 96 words in about 2.0 seconds (including initialization); this is not a benchmark. Synthetic artifacts: `/tmp/sih26-ocr-panel.png`, `/tmp/sih26-phase-one-observation.png`, and `/tmp/sih26-browser-baseline.json`.

Use [OCR notes](ocr.md) and the [extension README](../extension/README.md) for current setup and implementation details. Sections below retain the original Phase 1 history and broader project roadmap; statements about mock-only behavior and older verification are historical.

## 1. Project purpose and first complete target

SIH26 is a proposed privacy-conscious browser AI agent. The browser extension will observe a webpage, process visual content on the user's device, remove sensitive information before sending context to a reasoning server, validate the returned action, and execute it with user approval when required.

The repository identifies the problem as SIH26171, “On-device Visual Perception for Light-weight Browser Agents,” and links to the [official SIH 2026 statements](https://sih.gov.in/sih2026PS). Consult the official statement for competition requirements; this handoff does not independently verify its current contents.

The first complete workflow is a synthetic application form:

1. The user opens the test portal and asks the extension to fill and submit it.
2. Required personal values come from a temporary local profile supplied by the user. Missing information must not be invented. Login stays manual initially.
3. The extension observes DOM and screenshot information and runs local OCR/vision.
4. Privacy processing creates sanitized context and local value references.
5. The server proposes one structured action at a time.
6. The extension validates each proposal, resolves approved references locally, and executes it.
7. Submission requires confirmation, and success must be verified without blindly repeating an uncertain submission.

**This full workflow is not implemented yet.** The working deliverable today is the local observation foundation.

## 2. User decisions and scope to preserve

- The user asked for detailed implementation phases and simple, issue-by-issue explanations.
- The user requested the detailed plan as a separate file outside the actual project directory. It is [development-implementation-plan.md](../../development-implementation-plan.md).
- The user authorized Phase 1 implementation and specifically requested no unrelated changes.
- During implementation, the user clarified: **“do not go for any model pree training or implementing the model thing it will be done by other member I jut need the phase 1 structure with code base completely implemented.”**
- Accordingly, model libraries were removed from the final Phase 1 dependencies. There are no real OCR/vision implementations, model weights, training scripts, or model download commands in the delivered codebase.
- Model/OCR work belongs to another team member. Preserve that division unless the user changes the scope. A future plan mentioning a model does not itself authorize implementing that member's work.
- The user prefers concrete work and clear, easy explanations of what changed, what works, and what remains.
- Existing planning documents, the original README, `.gitignore`, and backend placeholders were left unchanged during Phase 1. This context-file request also changes only this new file.
- The roadmap is context, not an instruction to automatically implement every remaining phase in a new conversation. Follow the user's active request.

## 3. Directory locations — avoid the nested-root confusion

The workspace contains an actual project directory with the same name:

```text
/home/nik/Desktop/SIH26/                    Workspace wrapper
  development-implementation-plan.md       Detailed phase/issue backlog
  two-laptop-server-plan.md                Proposed deployment reference
  simple-explanations.md                   WebGPU/WASM/storage explanations
  SIH26/                                  Actual Git project root
    README.md
    .gitignore
    docs/
      project-context.md                  This handoff
      phase-one.md                        Implemented setup and verification
      architecture.md                     Original proposed architecture
      development.md                      Original milestones M1–M12
      privacy.md                          Required privacy/action rules
    extension/                            npm package and working code
      src/
      scripts/
      tests/
      dist/                               Generated unpacked extension
    server/                               Future backend placeholders
    tests/fixtures/                       Working synthetic portal/assets
```

Run npm commands inside `SIH26/extension/`, not the workspace wrapper or project root. Paths below are relative to the actual project root unless stated otherwise. The three reference files outside the project may not accompany a clone of the inner Git repository; this handoff summarizes their important decisions.

## 4. Which documents describe current reality?

| Reference | How to use it |
| --- | --- |
| [Phase 1 notes](phase-one.md) and current source | Implemented behavior, setup, verification, and model handoff |
| This context file | Dated overview, user decisions, project map, and remaining work |
| [Privacy rules](privacy.md) | Requirements for future export and execution features; not proof that those features exist |
| [Architecture](architecture.md) and [development milestones](development.md) | Original target design and milestone sequence |
| [Detailed phase plan](../../development-implementation-plan.md) | Proposed issue IDs, dependencies, and acceptance criteria |
| [Two-laptop plan](../../two-laptop-server-plan.md) | Proposed FastAPI/Ollama/ngrok deployment; no deployed server is implied |
| [Simple explanations](../../simple-explanations.md) | Background on local inference, screenshots, temporary storage, and TTL |

**Known stale statements:** The original README and architecture/development introductions say the project is documentation-only or has no code. That is outdated after Phase 1. Their proposed models and backend stack also must not be read as installed components. Prefer current source and `phase-one.md` for implementation status.

## 5. What is implemented now?

| Area / Phase 1 issue | Actual behavior |
| --- | --- |
| PH1-01 — Extension setup | Chrome Manifest V3, React, TypeScript, plain CSS, Vite build, npm lockfile, build/type/lint commands |
| PH1-02 — Synthetic portal | Application form with required validation, manual submission counter, hidden/disabled/delayed fields, layout toggle, image-only test text, fictional portrait |
| PH1-03 — Contracts | Strict Zod runtime schemas for internal messages, observations, six future action types, and a separate future sanitized request; generated JSON Schema |
| PH1-04 — Task lifecycle | Start, Observe again, Stop, status/errors, one task/tab/origin, invalidation, generation checks, and restart recovery |
| PH1-05 — DOM observation | Supported visible controls with labels, roles, types, bounds, disabled state, and local observation-scoped element references |
| PH1-06 — Capture | Visible-page screenshot, before/after consistency checks, viewport/scale metadata, pixel-dimension checks, optional numbered preview, DOM/capture timings |
| PH1-07 — Perception structure only | Typed adapter, validated results, fixed-fixture mock worker, cancellation and timeout handling. Real OCR/vision intentionally deferred |
| PH1-08 — Verification | Unit tests, isolated Chromium tests, timing summaries, and a recorded synthetic baseline |
| PH1-09 — Setup/handoff | Extension README, Phase 1 documentation, hardware-report script, troubleshooting, and teammate interface notes |

Important distinctions:

- The task text is currently panel input; no AI interprets it, and it is not forwarded to a planner.
- Green/orange boxes come from **DOM element positions**, not a vision detector. Orange indicates a disabled control.
- The screenshot is original local content, **not a redacted image**. Debugging boxes do not remove sensitive pixels.
- DOM control descriptions omit field values and include a limited sensitive-field marker. This is not a complete PII detector or privacy gateway.
- The fixture submits only when filled/submitted manually. Its JavaScript prevents network submission and increments a local counter.
- The mock worker returns predetermined data for a known image. It neither reads pixels nor detects text/faces.
- An action executor now exists (`extension/src/dom/act.ts`), but it performs one reviewed step at a time against one settled observation. It is not an autonomous loop, and it is not a complete action-authorization validator.
- A sanitized payload builder, a response translator, and an HTTP transport now exist and are connected to the project's reasoning server. The manifest permits that one origin and no other, so any other endpoint fails closed. The server itself is not in this repository.

## 6. Source map and implementation details

| File or folder | Responsibility |
| --- | --- |
| [extension/manifest.json](../extension/manifest.json) | Permissions, entry points, minimum Chrome version, content security policy |
| [extension/package.json](../extension/package.json) | npm commands and declared dependencies; lockfile supplies resolved versions |
| [extension/scripts/build.mjs](../extension/scripts/build.mjs) | Builds panel, background module, injected content-script IIFE, worker assets, and generated contracts |
| [extension/src/ui/main.tsx](../extension/src/ui/main.tsx) | Panel controls, local task text, opt-in screenshot overlay, statuses, and mock fixture button |
| [extension/src/background/index.ts](../extension/src/background/index.ts) | Chrome messaging, serialized state updates, session metadata, capture coordination, tab events |
| [extension/src/agent/lifecycle.ts](../extension/src/agent/lifecycle.ts) | State invalidation, generation checks, restart recovery |
| [extension/src/agent/transport.ts](../extension/src/agent/transport.ts) | Endpoint policy, the default endpoint, the single outbound POST, response size and status handling |
| [extension/src/agent/wire.ts](../extension/src/agent/wire.ts) | Maps the redacted payload onto the server's `/agent` body and unwraps its reply |
| [extension/src/agent/protocol.ts](../extension/src/agent/protocol.ts) | Server response translation, target and literal-text policy, one-step-per-observation gating |
| [extension/src/dom/act.ts](../extension/src/dom/act.ts) | Per-action execution: target re-verification, value writing, pointer and option handling |
| [extension/src/dom/content.ts](../extension/src/dom/content.ts) | Single injected listener/observer, local element map, page-change notifications |
| [extension/src/dom/observe.ts](../extension/src/dom/observe.ts) | Visible control collection, labels, bounds, viewport metadata |
| [extension/src/capture/observe.ts](../extension/src/capture/observe.ts) | Active-tab/origin checks, DOM snapshots, native screenshot, capture pacing and dimension checks |
| [extension/src/contracts.ts](../extension/src/contracts.ts) | Authoritative runtime/protocol schemas |
| [extension/src/vision/](../extension/src/vision/) | Teammate-facing interface and mock implementation only |
| [extension/src/metrics/timings.ts](../extension/src/metrics/timings.ts) | Sample count, median, and nearest-rank p95 helper |
| [extension/scripts/fixtures.mjs](../extension/scripts/fixtures.mjs) | Static fixture server bound to `127.0.0.1:4173` |
| [extension/scripts/hardware.mjs](../extension/scripts/hardware.mjs) | Basic OS/CPU/RAM/disk/Node report; GPU/VRAM remain manual |
| [tests/fixtures/](../tests/fixtures/) | Synthetic portal, scripts, styling, and assets |
| [extension/tests/](../extension/tests/) | Unit and browser tests; distinct from top-level fixture directory |

Current manifest permissions are `activeTab`, `scripting`, `sidePanel`, `storage`, and `debugger`. One external host is permitted: `https://hdtv-conditions-fathers-extensions.trycloudflare.com/*`, which is also the only origin in `connect-src`. Any further backend origin must be added to both, deliberately. A Cloudflare quick tunnel changes hostname when it is restarted; the value appears in `manifest.json` and as the configured agent endpoint in `extension/src/config.ts`, and both must be updated together.

Task states are `idle`, `observing`, `paused`, `stopped`, and `failed`. A successful single observation is stored as `paused` with an observation ID; the panel can display “Observation ready.” This is not an autonomous planning loop.

Stop and invalidation advance the task generation, preventing old results from being accepted. Necessary task metadata is stored in extension-only `chrome.storage.session`. Worker recovery pauses unfinished work and removes observation validity. Do not replace this with automatic reuse of worker globals or old screenshots.

The DOM collector returns at most 200 visible controls from the first 2,000 candidates. Hidden/offscreen controls are omitted and counted. The top-frame observation is not atomic on arbitrary animated pages. CSS-only changes between checks, canvas/video understanding, cross-origin frames, closed shadow roots, dialogs, CAPTCHA handling, and full-page capture are outside verified scope.

## 7. Contracts and the model teammate's handoff

The authoritative schemas are in `extension/src/contracts.ts`. The build generates:

```text
extension/dist/contracts/ActionResponseSchema.json
extension/dist/contracts/StepRequestSchema.json
```

These files are build artifacts for future backend compatibility, not a Python backend implementation. Edit the source schemas and rebuild; do not hand-edit generated files.

The future request/response envelope uses `protocolVersion: 1`, `requestId`, `taskId`, and `observationId`. IDs use letters, digits, underscores, and hyphens. Conceptual bracketed tokens in older planning prose, such as `[EMAIL_1]`, are not valid literal IDs under the current schema; use an opaque ID such as `value_email_1`.

Current action shapes:

| Type | Required arguments beyond `type` |
| --- | --- |
| `click` | `target` |
| `fill` | `target`, `valueRef` |
| `type` | `target`, `text` (literal, 1–200 characters) |
| `select` | `target`, `optionRef` |
| `choose` | `target`, `optionText` (literal, 1–200 characters) |
| `scroll` | `direction` (`up`/`down`), `pixels` (integer 1–2000) |
| `wait` | `milliseconds` (integer 1–5000) |
| `done` | None |

Unknown fields are rejected. Direct private fill values, arbitrary JavaScript, and unrestricted navigation are not accepted action forms. `type` and `choose` carry literal server text and were added deliberately for public form content such as a course name or a date. They are refused twice: `literalTextAllowed` in `extension/src/agent/protocol.ts` rejects credential- and PII-shaped text and text aimed at a control the observer marked sensitive, and `sensitiveControl` in `extension/src/dom/observe.ts` refuses the keystroke at execution time regardless of what was planned. Private values still travel only as a `valueRef` resolved from the local vault.

### The end-to-end round

`Run task` in the panel repeats one round at a time, at most `RUN_LIMIT` (8) of them. Each round is a scan the user could have requested by hand:

1. Observe the tab (DOM controls plus a tiled screenshot).
2. Run OCR, face and document detection locally; a failure in any of them stops the run.
3. Build the redacted payload through the privacy gateway; a blocked payload stops the run and is never sent.
4. `POST /agent` with `{ ss, page_info, instruction, problem_context }`, where `ss` is the redacted PNG, `page_info` lists only opaque element ids with redacted labels, and `instruction` is the sanitized instruction.
5. Translate the reply, perform the single step this observation still permits, and observe again.

A `finish` step, a refused step, a transport failure, or the round cap ends the run.

A server reply is not executed as written. `extension/src/agent/transport.ts` posts the sanitized payload; `planActions` translates each returned step, accepting only an element `id` the payload itself exported and discarding `className`/`xpath`; `executableNow` releases the leading `wait` steps plus a single page-touching step, because performing it retires the observation the user reviewed. The remainder is deferred until the page is scanned again. A refusal of `PAGE_CHANGED` during an automatic run is not a failure: the page simply moved on while the server was thinking, so the run observes again and continues within its round limit.

## Which page changes retire an observation — 2026-09-18

While a capture is running, mutations are classified and scored instead of every observer record invalidating the image. Style/class/framework churn, small non-interactive text counters, hidden/offscreen changes, animation lifecycle events, and DOM carrying `data-sih-extension-owned` are ignored when they leave reviewed geometry and capture-critical measurements unchanged. Interactive state/structure, visible media replacement, reviewed-target removal or movement, large subtree replacement, major visible text replacement, navigation, scroll/input, and material layout changes remain invalidating.

Capture waits for a 300 ms meaningful-mutation quiet window (bounded to 1.5 s) before taking its baseline. The final check uses a dedicated semantic snapshot: route/document identity, viewport and scroll position, document/scroll extents, total element count, and visible interactive structure/state/bounds. It does not compare revision counters, hidden counts, visual-region ordering, or the whole observation object. Renderer drift is tolerated up to 2 px for viewport/scroll, 4 px for interactive geometry, and 8 px or 0.5% for document extents; total DOM count requires both more than 10 elements and more than 10% change. A visible interactive addition/removal or state change remains exact and fails closed.

Failures retain the coarse `PAGE_CHANGED` state and add a structured `Capture Stability` detail with a reason code (`PAGE_CHANGED_NAVIGATION`, `PAGE_CHANGED_LAYOUT`, `PAGE_CHANGED_INTERACTIVE_STRUCTURE`, `PAGE_CHANGED_DOCUMENT_SIZE`, `PAGE_CHANGED_MAJOR_DOM_MUTATION`, `PAGE_CHANGED_TARGET_REMOVED`, or `PAGE_CHANGED_UNKNOWN`), before/after structural measurements, and ignored/significant mutation counts. Automatic runs permit four retries with a 250 ms incremental backoff and report the reasons when the limit is reached.

Once capture has finished, the question is narrower — is the control the user reviewed still the control that would be acted on, on the page that was reviewed? A mutation retires the observation when it reaches a reviewed control itself or its contents, when a reviewed control is detached, re-parented or replaced, when an image source changes pixels that were reviewed and redacted, or when the change **moves** a reviewed control: after any other mutation burst the reviewed boxes are re-measured, and a drift of more than 2px in any direction retires the observation. Churn that leaves every reviewed control exactly where the user saw it does not.

An *ancestor* of a reviewed control is deliberately not treated as touching it by containment alone — only by what it does to the control's box. This was the cause of a real failure: `touchesReviewed` also counted `target.contains(reviewedControl)`, so appending a notification toast to `<body>` or toggling a class on `<html>` — which every live application does every few seconds — retired the observation while the detectors and the reasoning server were still working. The server answered correctly, the reply translated correctly, and then every step was refused with `PAGE_CHANGED`: on a real site nothing was ever executed. Nothing is lost by the narrower rule, because the executor re-checks connection, visibility, disabled state, reviewed geometry and occlusion against the element at the instant of the action, so an ancestor change that does hide, move or cover the target is still refused there (`TARGET_CHANGED`).

The measurement is what keeps the narrower rule honest: toggling a class on a container that re-orders its children (the fixture's layout toggle) still retires the observation, because the controls move, while a toast pinned to a corner does not.

The stability regression suite runs the packaged extension in Chromium against a static page, a framework-style page updating counters/badges/classes every 20 ms, a CSS-animated page with repeated style updates, and a page replacing a 30-node result subtree every 30 ms. The first three capture successfully; the structural replacement is rejected with `PAGE_CHANGED_MAJOR_DOM_MUTATION`. These are bounded local browser fixtures, not proof that every public dynamic site is stable.

`extension/tests/browser/execute.spec.ts` runs the whole path through the shipped extension — panel → service worker → content script → page — for both halves of that rule, and `privacy-panel.spec.ts` covers the export lifecycle around it.

The perception interface in `extension/src/vision/contracts.ts` is:

```typescript
inspect(input: PerceptionInput, signal: AbortSignal): Promise<PerceptionResult>
```

Input includes `observationId`, an `ImageBitmap`, and an optional fixed-fixture identifier. The adapter owns the bitmap and must close it after use, including errors/cancellation. Output includes the matching observation ID, source (`mock` or `model`), regions of kind `text`, `face`, or `unknown`, pixel bounds in original-image coordinates, optional text/confidence, and elapsed time.

The existing mock accepts only `synthetic-details`, returns one predetermined text region after a simulated delay, and does not receive page screenshots through the UI. Its host is the panel document. A real worker host/offscreen-document decision, model assets, preprocessing, runtime/WASM permissions, and acceleration/fallback support remain the teammate's future work. A completed inference result must never itself mean “safe to export.”

## 8. Run the synthetic portal and extension

For the portal alone, from the current machine:

```bash
cd /home/nik/Desktop/SIH26/SIH26/extension
npm run fixtures
```

Open **http://127.0.0.1:4173/**. Keep the terminal running; Ctrl+C stops the server. This is a static test website, not the future AI API. The script runs directly in Node and does not need an extension build to serve the portal. No model or backend is needed.

For a fresh checkout and extension build, use Node.js 20.19 or newer and npm:

```bash
cd /path/to/project/extension
npm ci
npm run build
npm run fixtures
```

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select the generated `extension/dist/` directory, not the source folder. The manifest minimum is Chrome 116.
3. Open the synthetic portal and click the extension toolbar icon **on that tab** to grant temporary access and open the side panel.
4. Enter a task, optionally enable **Show local screenshot and element labels**, and select **Start observation**.
5. Change the page or scroll to exercise invalidation; use **Observe again** for a fresh capture.
6. Select **Stop** to cancel work and clear the current panel data.

Ctrl+Shift+Y is the configured extension shortcut if available. Opening an already-visible panel does not grant access to a new website. Restricted browser pages are unsupported.

After source changes, run `npm run build`, reload the unpacked extension, reload the fixture page, and invoke the toolbar icon again. The scripts use the extension working directory, so run them through npm from that directory.

## 9. Verification, environment, and Git state

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

Browser tests need the built `dist/`, permission to bind the fixture port, and Chromium. They use an isolated temporary profile and the unchanged production manifest. Browser-level CDP triggers the toolbar action rather than adding broad host permissions. Native viewport sizing is used because device emulation can disagree with native tab screenshot dimensions.

In the previous local run, browsers were installed under `/tmp/sih26-playwright-browsers`. To reuse that location, set `PLAYWRIGHT_BROWSERS_PATH=/tmp/sih26-playwright-browsers` for both installation and tests. Otherwise use Playwright's standard installation path. Temporary files may disappear; never assume the prior browser download is still present.

The test config writes results under `/tmp/sih26-playwright-results`; the browser test also writes synthetic observation/baseline artifacts under `/tmp`. It starts the fixture server automatically or may reuse one already running locally.

**Last recorded verification: 2026-09-07.** Build, TypeScript, and lint passed; 28 unit tests and 5 browser tests passed. Coverage included message validation, cancellation/restart state, capture mismatch rejection, manual fixture validation/submission, real local capture, 100%/125% zoom, scrolling, page-change invalidation, and Stop. The synthetic overlay was visually checked. No external HTTP(S) requests were observed by the test context, and inspected extension storage lacked screenshots, task text, and fixture private values. These are bounded test results, not universal privacy guarantees.

One recorded capture had 11 controls, 3.5 ms DOM collection, and 61.2 ms screenshot capture at 1280 × 913 CSS pixels and DPR 1. This is one illustrative sample, not a target or p95 benchmark. No model performance was measured.

The prior development machine reported Linux x64, Intel Core i7-13620H, 16 logical CPU cores, about 15.31 GiB RAM, Node 20.20.0, and test browser 153.0.8010.12. Laptop 2 specifications, GPU/VRAM, and real-model compatibility remain unknown.

**Git snapshot at this handoff:** Phase 1 additions are present but untracked in the inner repository; previously tracked files show no modifications. No commit, push, PR, or deployment was performed. Recheck `git status` in a new session and preserve all existing work, including untracked files. `node_modules/` and `dist/` are ignored build/dependency directories.

## 10. Privacy and action requirements for future implementation

These requirements come from `docs/privacy.md` and the agreed design. They are not claims that Phase 2 or later exists.

- Local screenshots can contain private content even when DOM field values are omitted. Current previews are original local data.
- Keep original images, private values, and value mappings out of persistent storage, logs, telemetry, and server requests. Current task text and observation previews live only in panel memory; necessary task metadata uses restricted session storage.
- Disabling the preview, invalidating an observation, stopping, or closing the panel releases its observation references. Memory release is not guaranteed immediate physical erasure.
- Export only necessary sanitized context. Check user instructions, labels, OCR text, images, URLs/titles, and any other included metadata.
- Exclude passwords, OTPs, authentication tokens, and API keys. Do not provide reusable credential references to the planner.
- Keep ordinary private-value mappings local and bind references to task, website, and approved destination field. Clear them when the task ends or expires.
- Image redaction must replace pixels in the encoded output. An overlay alone is insufficient.
- Withhold uninspectable regions and block affected exports on incomplete processing or failures. Every AI request must pass the final gateway.
- Webpage content and server action proposals are untrusted. Page instructions cannot authorize actions or override the user's task.
- Validate IDs, current origin, observation freshness, target, arguments, and private-value destination locally. Never execute model-generated JavaScript.
- Submit/send/delete/purchase/payment/upload require local confirmation with destination and effect. Revalidate after approval if the page changes.
- Verify outcomes, ignore late/duplicate responses, and do not automatically repeat an uncertain submission. Add step/time limits in the complete loop.
- The ordinary website receives form values when filled/submitted. That destination is separate from the reasoning server; the extension does not control all browser traffic.

## 11. Planned two-laptop architecture — not deployed

```text
Laptop 1: Chrome + extension
  DOM and image observation → local perception → privacy processing
  → final export gateway → sanitized request + application token
                           ↓
                 HTTPS endpoint / ngrok
                           ↓
Laptop 2: FastAPI → locally running reasoning model through Ollama
  validate request → propose one action → validate response
                           ↓
Laptop 1: validate → approve if required → execute → verify
```

The proposal is one Python/FastAPI/Pydantic backend, one locally deployed open-weight reasoning model, and JSON request/response transport. No database or general agent framework is needed initially. Exact model, memory limits, and performance budgets remain undecided.

Proposed endpoints are authenticated `GET /health` and `POST /agent/step`. For the tunnel arrangement, FastAPI would bind to `127.0.0.1:8000` on Laptop 2 and Ollama to its local `127.0.0.1:11434`. Expose only the protected API. ngrok forwards traffic; it does not host the model.

Laptop 1's localhost cannot address Laptop 2. Future extension setup needs the actual endpoint, scoped permissions, an appropriate connection policy, and a separate application credential. The ngrok account token belongs on Laptop 2 and is not the API credential. Do not store either credential in documentation or source.

Configure tunnel/body/header inspection and retention appropriately before use. If requirements cannot be met, restrict the route to synthetic data. A trusted LAN is a possible fallback requiring explicit binding/firewall/authentication/permission setup; HTTPS is the intended route for non-synthetic traffic.

**None of FastAPI, Ollama integration, ngrok setup, API authentication, or extension server transport has been implemented here.** The only running-localhost instructions currently available are for the static synthetic portal.

## 12. Remaining implementation order

The detailed backlog uses `PH1`–`PH6` issue prefixes. These are distinct from the P0/P1/P2 priorities and M1–M12 milestones in the older development document.

| Phase / workstream | Remaining deliverable and completion gate |
| --- | --- |
| Real perception handoff | Teammate supplies actual OCR/visual adapter, original-image coordinates, cancellation/cleanup, and measured compatibility. The mock is never substituted for real detection evidence |
| Phase 2 — Privacy | Sensitive-text rules, visual detections, temporary local profile/value references, text/pixel redaction, compact context, final export gateway, actual outgoing preview, and leakage checks. Gate: useful sanitized request; incomplete inspection blocks export |
| Phase 3 — Backend/planner | Authenticated API, compatible schemas, request limits, deterministic synthetic test planner, then reasoning-model adapter and structured single-action output. Gate: valid proposals or controlled errors |
| Phase 4 — Execution | Contextual action validator, local handlers, consequence checks/approval, result verification, and duplicate/late-action prevention. Gate: a fixed test sequence fills the fixture, obtains approval, submits once, and verifies success |
| Phase 5 — Integration | Complete observe/protect/plan/act loop, limits/expiry/recovery, two-laptop connection, transport failures. Gate: the real planner completes the agreed synthetic form workflow |
| Phase 6 — Evaluation | Held-out layouts/languages, failure and injection cases, DOM/vision comparisons, privacy/task/resource/latency measurements, demo runbook and handover |

Backend work can start independently with synthetic fixtures while privacy/perception is developed. Captured page content must not reach a server before the privacy gate is ready. Test execution with deterministic responses before depending on model variability.

A useful next shared milestone is **a useful sanitized request for the test page, with the exact outgoing content visible and checked locally**. Work on text rules, mappings, fixtures, or a synthetic backend can proceed without taking over the other member's real-model work.

Later expansion includes stronger name/address detection, broader language/layout support, controlled navigation, local shortcuts through the common validator, measured performance tuning, and other browsers. Multiple simultaneous tasks/tabs, general PDF/video workflows, accounts, and a large local language model remain deferred.

Open decisions include exact local/remote models, teammate delivery status, Laptop 2 hardware, endpoint/token provisioning, retention settings, task TTL/step/time budgets, numeric evaluation targets, and deployment connectivity. Do not fill these gaps with assumed completed work.

## 13. How to resume in a new conversation

Suggested opening request from the workspace wrapper:

> Read `SIH26/docs/project-context.md` and `SIH26/docs/phase-one.md`, inspect the current code and Git status, then help me with [specific task]. Preserve the model-work ownership boundary unless I explicitly change it.

If the new workspace opens directly at the inner project root, use `docs/project-context.md` and `docs/phase-one.md` instead. If outside reference files are absent, use this handoff plus the repository docs/source.

After a meaningful implementation change, update this context's date, actual status, relevant decisions, and verification evidence when documentation updates are in scope. Keep proposed, implemented, and tested behavior distinct, and never add credentials or real private data to the handoff.

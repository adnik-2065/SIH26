# Local vision: MediaPipe now, trained PII detector later

Implemented 2026-09-09. This change adds face detection and redesigns the extension panel. It does not implement document detection, PII redaction, a payload builder, transport, or browser actions.

## What runs today

```text
Visible page capture + DOM controls
       ├─ Tesseract worker → English words, confidence, pixel boxes
       └─ MediaPipe worker → face boxes, confidence
                              ↓
                     Local review panel
```

MediaPipe BlazeFace short-range float16 v1 uses the pinned `@mediapipe/tasks-vision` 1.0.1 runtime, IMAGE mode, CPU delegate, confidence threshold 0.5, and suppression threshold 0.3. Google documents image preprocessing inside the task and recommends workers to avoid blocking the UI: [Face Detector web guide](https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector/web_js).

**Wide-page correction (2026-09-09):** A single whole-screenshot pass was unreliable for smaller portraits on desktop-sized pages; the initial browser tests captured only an approximately 894-pixel-wide page. The worker now also scans overlapping crops (512-pixel minimum side, enlarged for very large screenshots, capped at 25 crops). Crop results are translated back into original screenshot coordinates. Confidence-ranked suppression removes overlapping and near-contained duplicates, including loose whole-page boxes around stronger crop detections. The original whole-image pass remains for large faces. The threshold stays at 0.5. All passes run even if the first finds a face, so other faces can still be found. The existing timeout/cancellation covers the entire operation. This adds inference work and still does not guarantee detection of every face.

The classic worker is separately built to support MediaPipe's WASM loader. Runtime, WASM, and weights are bundled; the build checks the weights' SHA-256. No CDN, camera permission, external host permission, or remote inference is needed. Asset provenance is in `extension/assets/mediapipe/README.md`.

Both detectors receive separate bitmaps from the same screenshot and keep results separate. Each result carries the observation ID. Face boxes use original screenshot pixels, with partly off-image boxes clipped. Invalid output fails the scan. MediaPipe is reused between successful scans; a 30-second timeout, error, or cancellation terminates its worker. OCR retains its 90-second deadline and 500-word limit. Results do not become privacy clearance, including when zero faces are found.

The panel rejects stale results after a page/tab change, Stop, or disabling local analysis. Stop, opt-out, and panel disposal release both workers. The workflow display, per-engine status, searchable text list, face list, layer toggles, and selection highlights support narrow side panels. The workflow/results organization is inspired by [n8n's visual editor](https://n8n.io/features/); it is not an n8n integration.

## Run it

From `extension/`:

```bash
npm ci
npm run build
npm run fixtures
```

Reload `extension/dist` at `chrome://extensions`. Reload the webpage and click the extension toolbar icon on that tab. Select **Scan current page**, then review **Text** and **Faces**. Selecting a result highlights its position. Use **Full size** to inspect small details. **Scan again** captures a fresh view; **Stop** clears it.

The default runs OCR and face detection together. Scan settings lets you turn off local analysis and keep page-control observation only. Turning it back on requires another scan.

## Add your trained model later

1. Agree on the model artifact and runtime: input size, RGB/BGR order, normalization, resize versus letterbox, output tensors, class IDs, confidence threshold, and suppression rules. A `.pt` training checkpoint cannot simply be passed to the face detector. Choose a browser runtime supported by your exported model. A compatible TFLite object detector can use MediaPipe ObjectDetector; an ONNX model needs an ONNX-capable runtime. Compatibility must be validated against the actual artifact.
2. Add a separate adapter under `src/vision/documents/` implementing the existing `PerceptionAdapter.inspect(input, signal)` interface, with a worker, local weights, timeout, cancellation, and disposal. Keep the face detector and OCR adapters. The panel's observation effect currently starts these two adapters; add the third there, or extract this into a detector registry as the set grows.
3. Extend `src/vision/contracts.ts` deliberately. It currently permits only `text`, `face`, and `unknown`. Add supported document kinds such as `aadhaar`, `pan`, `passport`, `payment_card`, and `document`, plus validated provenance if needed. Do not mislabel documents as faces or assume a detector can recognize every document class.
4. Undo model resize/letterbox transforms before returning boxes. For a scale `s` with padding `(padX, padY)`, map `x = (modelX - padX) / s`, `y = (modelY - padY) / s`, `width = modelWidth / s`, `height = modelHeight / s`; also add crop offsets if inference used tiles. Clamp to the original screenshot and reject invalid boxes. Use a separate bitmap per worker and the same observation ID.
5. Keep per-detector completion/errors. Add UI results and tests using fictional documents, small/partial images, multiple documents, zoom, blank scenes, failures, and cancellation. Measure recall on held-out layouts; one passing fixture is not sufficient evidence for a privacy gate.
6. Feed text, face, and document regions into the future privacy stage. Usually the entire ID/card region should be covered. Overlapping face/document masks can be merged; retain the reason/provenance locally. A document detector finds *where a document is*; OCR and sensitive-text rules identify *which text needs protection*.

No trained document detector or extra model runtime is installed by this change.

## Is preprocessing/redaction finished after this?

**No.** Capture, OCR, and face localization are implemented. Redaction still needs its own stage:

1. Detect sensitive text in OCR, DOM labels, and the user's note using appropriate rules/models, including split OCR words. Omitted form values alone do not make all page context safe.
2. Combine sensitive-text boxes with face/document boxes. Add appropriate padding; handle incomplete or uninspectable regions by withholding them or blocking export.
3. Replace sensitive text with safe descriptions/references. Keep the real values in temporary local mappings bound to task, site, and approved destination. Passwords, OTPs, tokens, and keys must not be sent or offered as reusable planner references.
4. Paint opaque masks into a separate output canvas and encode a new image. Colored outlines, CSS overlays, and merely hiding text in the UI do not redact the exported pixels.
5. Build minimal context and run a final privacy check across every included field and encoded image. Show the actual outgoing payload locally. Block sending on incomplete checks or required detector failures.

In simple terms: **find private information → replace private text → cover private pixels → check the final output → send only that checked output.** Face detection can miss small, angled, occluded, or distant faces and does not recognize Aadhaar/PAN/passport/card types or identify a person.

## What will the final payload look like?

The existing `StepRequestSchema` in `src/contracts.ts` defines the future JSON envelope. This text-only example conforms to it, but no code currently builds or sends it:

```json
{
  "protocolVersion": 1,
  "requestId": "request_1",
  "taskId": "task_1",
  "observationId": "observation_1",
  "sanitizedInstruction": "Fill the application using my approved local profile",
  "elements": [
    { "id": "field_name", "role": "textbox", "description": "Full name field" }
  ],
  "valueRefs": [
    { "id": "value_name_1", "purpose": "Applicant name", "target": "field_name" }
  ]
}
```

- IDs connect a request to the current task, page observation, and local controls.
- `sanitizedInstruction` is the user's request after removing private content.
- `elements` describes usable page controls without their private values.
- `valueRefs` tells the server which approved local values are available, without including the values themselves. Even descriptions/purposes must be sanitized.
- Optionally add `sanitizedImage: { "mimeType": "image/png", "base64": "...actual encoded redacted PNG..." }` only after pixel redaction and the final check. The base64 value excludes the `data:image/png;base64,` prefix. The schema limits it to 4,000,000 characters; downscale or omit it when necessary. Do not send the original screenshot.

The current envelope has no top-level raw OCR, raw face result, document list, URL, or title field; adding any requires an explicit schema/privacy decision. Keep necessary safe text in supported descriptions or extend the contract intentionally.

A later server can reply with `action: { "type": "fill", "target": "field_name", "valueRef": "value_name_1" }` inside the matching response envelope. The extension would validate the action, look up the real name locally, and fill the approved field. Payload building, privacy gating, server communication, and execution are still future work.


## Verification — 2026-09-09

Production build, TypeScript, lint, 46 unit tests, and 9 Chromium browser tests passed. Unit tests cover face-box validation, clipping, overflow, cancellation, timeout, stale results, engine reuse, and failures. Browser tests use the bundled real model and fictional portrait, check face alignment at 100%/125% zoom, replace portrait pixels with white to get zero faces, exercise selection/search and Stop/opt-out/restart, and simulate a missing model to check incomplete status and retry while retaining OCR results. The failure simulation uses a temporary test-only worker bootstrap; it is removed afterward and does not change production assets.

No external HTTP(S) requests or page errors were observed. Inspected extension storage did not contain screenshot data or fixture OCR/private text. The 380-pixel UI and face overlays were visually checked (`/tmp/sih26-vision-panel.png`). The JSON example above passed the generated `StepRequestSchema`. These bounded tests do not measure general face recall or establish privacy clearance.


After the wide-page correction: build, TypeScript, lint, **55 unit tests and 13 Chromium browser tests passed**. Added real-model regressions for 1373 × 999, 1920 × 1080, DPR 2 (2746 × 1998 screenshot pixels), and a portrait crossing a crop boundary; each produces one face box inside the portrait. Unit checks cover crop coverage/overlap/bounds, pass limits, nested duplicates, and separate faces. The previous empty-face, zoom, worker cleanup, and failure/retry checks remain passing. Reload the rebuilt extension to activate this worker change.

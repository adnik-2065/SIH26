# SIH26 Redaction Engine — Implementation Handoff

**Status:** Implementation plan only. It does not claim that redaction, export, server transport, or browser actions already exist.  
**Audience:** The engineer/model implementing the local privacy and redaction stage.  
**Scope:** Build a fail-closed redaction engine between local page detection and future server export. Do not add a server, browser action executor, trained document model, new UI redesign, or unrelated changes unless separately requested.

Read [project-context.md](project-context.md) and [privacy.md](privacy.md) before implementation. Current source code overrides older historical documentation where they disagree.

---

## 1. Goal

The extension currently captures a page locally, performs local OCR and face detection, and shows an **unredacted local preview**. The next stage must create a separate, safe export representation.

The redaction engine must:

1. Receive findings from OCR, MediaPipe face detection, DOM metadata, future document/PII models, and the user instruction.
2. Identify sensitive information locally.
3. Replace sensitive strings with safe placeholders in exported text.
4. Paint opaque masks into a newly encoded image; UI overlays are not redaction.
5. Keep real private values and mappings local, temporary, and out of logs/storage/network requests.
6. Build only the minimum server context needed for the next action.
7. Validate every outgoing request through one final privacy gateway.
8. Block export when required inspection/redaction is incomplete or unsafe.

The server must never receive raw screenshots, raw OCR output, raw DOM values/HTML, passwords, OTPs, authentication tokens, API keys, or local value mappings.

---

## 2. Current implementation reality

### Already available

| Source | Current location | What is available | Coordinate space |
| --- | --- | --- | --- |
| Capture | `extension/src/capture/observe.ts` | Full-page capture as bounded, overlapping image tiles | Original full-page image pixels |
| Local observation | `extension/src/contracts.ts` | `LocalObservation`, image dimensions, tile ownership | Original full-page image pixels |
| OCR | `extension/src/vision/ocr/` | English words, confidence, rectangles | Original full-page image pixels |
| Faces | `extension/src/vision/face/` | Face rectangles, confidence | Original full-page image pixels |
| DOM controls | `extension/src/dom/observe.ts` | Visible control label, role, type, disabled/sensitive flag, bounds | Viewport CSS pixels |
| UI | `extension/src/ui/main.tsx` | Local unredacted screenshot preview and detection results | N/A |
| Future server schema | `extension/src/contracts.ts` | Strict `StepRequestSchema` and `ActionResponseSchema` | N/A |

### Not implemented

- Sensitive-text classification.
- Document/Aadhaar/PAN/passport/card detector.
- Text replacement, image pixel masking, payload builder, export gateway, server transport, or action executor.
- Any raw DOM input-value collection. This omission is intentional.

### Important current constraints

- OCR and face results are `PerceptionResult` values with `text`, `face`, or `unknown` kinds. A completed detector is not proof that a page is safe.
- The full-page screenshot can be many image tiles. Do not allocate an unrestricted canvas for the whole page.
- DOM controls represent only visible controls and do not contain values. Labels/placeholders/ARIA text can still contain PII and must be sanitized if exported.
- Pages can change. The existing observation ID, document ID, revision, origin checks, task generation, Stop, and cleanup behavior must be preserved.
- Current request schema permits an optional redacted image no larger than 4,000,000 Base64 characters. It does not permit raw OCR, raw face regions, URLs, titles, or arbitrary metadata.

---

## 3. Required privacy model

Treat every source as untrusted until it has passed local policy. Use these separate concepts:

| Concept | Meaning | May reach server? |
| --- | --- | --- |
| Raw finding | Original OCR text, face/document box, DOM text, instruction fragment | No |
| Sensitive finding | A local classification such as email, face, PAN, or password | No |
| Redaction mask | Rectangle(s) to overwrite in image pixels | No, except local summary/counts |
| Sanitized text | Text with placeholders such as `[EMAIL_1]` | Yes, if needed and final-checked |
| Local value reference | Opaque handle to a user-approved local profile value | Yes, but never its value or mapping |
| Export decision | `safe`, `safe_without_image`, or `blocked` | Safe operational state only |

### Never export or offer as a value reference

- Passwords, OTPs, authentication/session tokens, API keys, recovery codes, private keys.
- Raw OCR text, raw document text, raw DOM field values, raw HTML, selectors, screenshots, URLs, page titles, history, error messages, or local profile mappings.
- PII discovered on the current webpage. It must be redacted, not converted into a reusable server reference.

### Local value references are only for user-approved data

Example local-only mapping:

```text
value_applicant_name_1 -> actual applicant name
```

The server can receive only `value_applicant_name_1`. The extension may resolve it only after validating task, observation, origin, and approved target field.

---

## 4. Target architecture

```text
Capture + DOM snapshot + local OCR/faces/future document model + user instruction
                                      |
                                      v
                         Normalize into local Findings
                                      |
                                      v
                  Local PII classification and policy decisions
                                      |
                                      v
             Merge text/face/document masks and sanitize text
                                      |
                                      v
          Redact image tiles into newly encoded redacted output
                                      |
                                      v
      Final privacy gateway: validate coverage + inspect final payload
                              |                         |
                         safe export                 blocked export
                              |
                              v
          Strict StepRequestSchema -> one future server request
```

Create a dedicated local module:

```text
extension/src/privacy/
  contracts.ts       Local Zod schemas and TypeScript types
  normalize.ts       Convert all detector/DOM/instruction data to Findings
  classify.ts        Rule-based PII detection and policy classification
  text.ts            String tokenization/replacement and safe descriptions
  geometry.ts        Coordinate conversion, padding, clipping, mask merging
  image.ts           Bounded tile-by-tile canvas masking and PNG encoding
  value-vault.ts     In-memory, task-scoped approved local-value references
  payload.ts         Minimal StepRequest construction
  gateway.ts         One fail-closed outbound export function
  index.ts           Public API only
```

Use workers for expensive local text/visual processing if needed. Keep the gateway and task/origin freshness checks in the extension-controlled flow. Do not add a network call in a detector, UI component, or arbitrary helper.

---

## 5. Local contracts

Add local contracts under `src/privacy/contracts.ts`. They should be strict Zod schemas and should not automatically become server contracts.

```ts
type FindingSource = 'ocr' | 'face' | 'dom' | 'document' | 'instruction';

type PiiKind =
  | 'person_name'
  | 'email'
  | 'phone'
  | 'address'
  | 'date_of_birth'
  | 'aadhaar'
  | 'pan'
  | 'passport'
  | 'payment_card'
  | 'bank_account'
  | 'ifsc'
  | 'face'
  | 'document'
  | 'password'
  | 'otp'
  | 'token'
  | 'api_key';

type ExportPolicy = 'replace' | 'mask' | 'withhold' | 'block';

interface Finding {
  id: string;
  source: FindingSource;
  kind: PiiKind;
  confidence: number;             // use 1 for deterministic validated rules
  text?: string;                  // local only, never serialized for export
  bounds?: Rect;                  // global original-image pixel coordinates
  elementId?: string;             // observation-local DOM reference
  exportPolicy: ExportPolicy;
  redactText: boolean;
  redactPixels: boolean;
}

interface Mask {
  bounds: Rect;
  reasons: PiiKind[];
}

interface RedactionPlan {
  observationId: string;
  findings: Finding[];            // local only
  masks: Mask[];                  // local only
  sanitizedInstruction: string;
  sanitizedElements: Array<{ id: string; role: string; description: string }>;
  valueRefs: Array<{ id: string; purpose: string; target: string }>;
  coverage: {
    instruction: 'complete' | 'incomplete';
    dom: 'complete' | 'incomplete';
    ocr: 'complete' | 'incomplete';
    faces: 'complete' | 'incomplete';
    documents: 'not_enabled' | 'complete' | 'incomplete';
    image: 'not_requested' | 'complete' | 'incomplete';
  };
  decision: 'safe' | 'safe_without_image' | 'blocked';
  blockedReasons: string[];       // safe operational labels only
}
```

Rules:

- Bounds must be finite, non-negative, non-empty, and clipped to image limits.
- Local findings must carry the active observation ID indirectly through their plan; never merge findings from different observations.
- Use opaque IDs. Do not place actual PII in IDs, reason strings, logs, or telemetry.
- Add exact limits for finding count, mask count, text length, and image output bytes before implementation.

---

## 6. Normalize each data source

### OCR

1. Consume `PerceptionResult` only if its `observationId` matches the active observation.
2. Sort words into lines by vertical proximity and left-to-right order.
3. Group nearby words before classification. OCR can split an email, card number, or ID number into several regions.
4. Preserve a mapping from every reconstructed string span back to its contributing OCR boxes.
5. A matching sensitive span produces both text replacement information and a combined pixel mask.

### Face and future document models

1. Verify matching observation ID, valid confidence, and in-image rectangle.
2. Faces produce pixel masks only; they do not identify people.
3. Aadhaar/PAN/passport/payment-card/document detections mask the full detected document/card rectangle.
4. A document detector is a location signal. OCR/rules identify additional textual PII, but must never shrink a document mask.
5. Extend `src/vision/contracts.ts` deliberately when the document-model teammate supplies agreed classes. Do not label documents as faces or assume every document is detected.

### DOM

1. Start from the existing observed controls; do not change the collector to export raw input values.
2. Classify only strings that could be sent: labels, placeholders, ARIA labels, option descriptions, and user-facing button/link descriptions.
3. Existing `sensitive: true` controls must use a generic safe description such as `Sensitive field` and must not create a `valueRef` for credentials.
4. DOM bounds are viewport CSS pixels. Convert to global image pixels before making image masks:

```text
scaleX = imageWidth / captureBounds.width
scaleY = imageHeight / captureBounds.height
imageX = (domX + scrollX - viewportOffsetX) * scaleX
imageY = (domY + scrollY - viewportOffsetY) * scaleY
```

5. DOM collection covers visible controls only. Do not claim it covers all page text.

### User instruction and local profile

1. Classify and replace PII in the user instruction before export.
2. Store a user-approved profile separately from page observation data.
3. Generate `valueRefs` only for allowed, explicitly approved profile values and the intended target control.
4. A detected value from webpage OCR/DOM is never a profile value reference.

---

## 7. PII classification policy

Implement conservative local rules first, then add a local NER model only after measurement and review.

### Initial deterministic rules

| Category | Initial method | Important validation |
| --- | --- | --- |
| Email | RFC-lite local pattern | Do not expose matched text |
| Phone | India-aware and generic phone patterns | Require plausible digit count/context |
| PAN | Format pattern | Treat as candidate; do not invent checksum claims |
| Aadhaar | 12-digit candidate pattern | Validate with Verhoeff only if correctly implemented and tested |
| Payment card | 13–19 digits with separators | Require Luhn validation |
| IFSC | Format pattern | Validate only documented structural format initially |
| Password/OTP/token/key | DOM type/autocomplete + conservative text labels/patterns | Always withhold/block, never reference |
| Names/address | Later local NER plus conservative surrounding-label rules | Treat uncertain detection as incomplete for visual export where needed |

### Policy decisions

| PII kind | Sanitized text | Image pixels | Server value reference |
| --- | --- | --- | --- |
| Email, phone, PAN, Aadhaar, card, address | Replace with typed placeholder | Opaque mask | Never from page finding |
| Face | No text needed | Opaque mask | Never |
| Entire document/card | Generic description only | Opaque mask over full region | Never |
| User-approved normal form value | Generic purpose only | Mask if visible on page | Allowed only for approved target |
| Password, OTP, token, API key | Withhold/block | Mask if visible | Never |

Use deterministic placeholder generation per task, for example `[EMAIL_1]`, `[PHONE_1]`, `[FACE_1]`. The placeholder mapping remains in memory and is cleared at task end. Do not use raw values to derive placeholder identifiers.

---

## 8. Geometry and visual masking

### Build masks

1. Convert every visual finding to original full-page image pixels.
2. Apply category-specific padding. Padding must be configurable and tested.
3. Clip masks to the full image boundary.
4. Merge overlapping or touching masks into a union mask while retaining local reason categories.
5. Do not expose detailed mask coordinates unless a future schema explicitly requires safe layout metadata.

### Tile handling

Current capture tiles have global `y`, `start`, `end`, width, and height. For each tile:

1. Find every global mask intersecting the tile image bounds.
2. Translate it to tile-local coordinates: `tileY = globalY - tile.y`.
3. Clip it to the tile rectangle.
4. Paint an opaque fill into the tile-local canvas.
5. Process masks in overlap regions for every affected tile, even when the preview shows ownership bands only.

This prevents sensitive pixels leaking through capture-tile seams.

### Image output rules

- Use a separate output canvas/ImageBitmap. Never mutate the original local preview or send its PNG.
- Use opaque masking. A transparent mask can reveal pixels when composited later.
- Do not rely on blur; it can remain reversible or readable.
- Ensure masks are painted before encoding.
- Release image/canvas buffers after each tile, Stop, invalidation, opt-out, or panel close.
- Do not build an unlimited whole-page canvas.

### Size limits and long pages

`StepRequestSchema` currently allows one optional `sanitizedImage` with at most 4,000,000 Base64 characters.

For the first implementation:

1. Prefer a text/control-only request when visual context is not necessary.
2. Include a redacted image only when it fits the schema limit and all relevant image coverage is complete.
3. If a bounded visual summary is required, redact at source resolution first, then produce the summary. Apply projected masks again after downscaling to prevent edge leakage.
4. Do not send multiple arbitrary tile images until a deliberately versioned server contract supports that design.
5. Do not substitute an original image if a redacted image is too large or fails to encode.

---

## 9. Text sanitization

Create pure functions that accept a string and local findings and return sanitized output plus local replacement metadata.

```ts
sanitizeText(
  raw: string,
  context: 'instruction' | 'element_description' | 'ocr'
): { sanitized: string; findings: Finding[] }
```

Required behavior:

- Replace exact matched spans with typed placeholders.
- Preserve enough grammar for the server to understand the task.
- Never include raw matched values in errors, logs, placeholder IDs, analytics, or the payload preview.
- If text cannot be safely classified or is truncated, withhold it rather than guessing.
- OCR sanitization supports image masks and local review; raw OCR should not be added to the current server schema.
- Sanitize text again at final payload construction. The second pass catches accidental leaks from descriptions, purposes, or future fields.

Example:

```text
Input:  "Contact Priya at priya@example.test before 9876543210."
Output: "Contact [PERSON_1] at [EMAIL_1] before [PHONE_1]."
```

---

## 10. Local value vault

Implement an in-memory value vault, not persistent storage.

```ts
interface LocalValueRecord {
  id: string;
  taskId: string;
  observationId: string;
  origin: string;
  target: string;
  purpose: string;       // already sanitized
  value: string;         // local only
  expiresAt: number;
}
```

Rules:

- Bind each record to task ID, current origin, observation ID, and target element ID.
- Generate opaque random IDs such as `value_applicant_name_1`.
- Do not put records in `chrome.storage`, logs, telemetry, request bodies, URL parameters, or UI copy/paste text.
- Clear on Stop, invalidation, task completion, expiration, panel disposal, and worker restart.
- Reject an action if any binding no longer matches.
- Do not store or reference passwords, OTPs, tokens, API keys, or sensitive values extracted from the webpage.

---

## 11. Payload construction and final gateway

The only public export entry point should be conceptually:

```ts
buildSafeStepRequest(input): Promise<
  | { ok: true; request: StepRequest }
  | { ok: false; blockedReasons: string[] }
>
```

It must run in this order:

1. Confirm task/generation/origin/observation freshness.
2. Confirm required detector outcomes and coverage.
3. Normalize and classify all exportable sources.
4. Create the redaction plan.
5. Build sanitized descriptions, instruction, and allowed local `valueRefs`.
6. Encode a redacted image only if needed and safe.
7. Scan every string placed in the outgoing object for direct PII leaks.
8. Confirm no forbidden fields are present.
9. Validate with `StepRequestSchema.parse(request)`.
10. Show the final outgoing summary/payload to the user locally.
11. Only a future approved transport module may send the already-validated object.

### Fail-closed behavior

Block the affected export when any of these occur:

- Active page/task/observation changed.
- OCR, face detection, required document detection, masking, or final validation fails.
- OCR is truncated, over its result limit, or has unknown coverage for an image being exported.
- A required tile is missing, invalid, or cannot be redacted.
- A sensitive region has invalid coordinates.
- A raw value appears in a candidate request field.
- The redacted image exceeds contract limits and visual context is required.
- The browser action asks to resolve a value reference for the wrong origin/target/task.

It is acceptable to return `safe_without_image` when image export is optional and the remaining structured request is fully sanitized. It is not acceptable to send an incomplete or original screenshot.

---

## 12. Existing version-1 server payload

Do not change the server contract casually. The current `StepRequestSchema` supports exactly:

```json
{
  "protocolVersion": 1,
  "requestId": "request_4c0f",
  "taskId": "task_71a2",
  "observationId": "observation_a91b",
  "sanitizedInstruction": "Fill the application using my approved local profile.",
  "elements": [
    {
      "id": "observation_a91b_e1",
      "role": "textbox",
      "description": "Applicant name field"
    },
    {
      "id": "observation_a91b_e7",
      "role": "button",
      "description": "Submit application"
    }
  ],
  "valueRefs": [
    {
      "id": "value_applicant_name_1",
      "purpose": "Applicant name",
      "target": "observation_a91b_e1"
    }
  ],
  "sanitizedImage": {
    "mimeType": "image/png",
    "base64": "iVBORw0KGgoAAAANSUhEUg..."
  }
}
```

`sanitizedImage` is optional. Its Base64 value must be the actual newly encoded redacted PNG without the `data:image/png;base64,` prefix.

The version-1 schema has no top-level raw OCR, raw face result, document list, page URL, title, or private-value field. Do not add any of those as ad hoc keys. If safe semantic page text becomes necessary, design, review, version, and test a deliberate schema extension before implementation.

The server can later reply with one matching action:

```json
{
  "protocolVersion": 1,
  "requestId": "request_4c0f",
  "taskId": "task_71a2",
  "observationId": "observation_a91b",
  "action": {
    "type": "fill",
    "target": "observation_a91b_e1",
    "valueRef": "value_applicant_name_1"
  }
}
```

The redaction engine does not implement execution. A future action validator resolves the real value locally only after all local checks pass.

---

## 13. UI and lifecycle requirements

Preserve the existing panel’s visual language and capture/detection experience. Add only redaction-specific review states when the redaction stage is implemented.

Required user-facing behavior:

- Clearly distinguish **Local original preview** from **Redacted export preview**.
- Show categories/counts such as faces masked, text values replaced, and documents masked without displaying raw detected values in non-local diagnostic output.
- Show a clear blocked reason when export is unavailable, for example `OCR did not complete; visual export was blocked.`
- Show the exact payload structure or a safe summary before a future send.
- Preserve Stop. Stop must abort masking/encoding, discard generated output, clear vault references, and prevent late results from appearing.
- A changed page invalidates the redaction plan and output just like it invalidates the current observation.
- Preview opt-out and panel close must release raw/redacted image buffers and local findings.

Do not claim redaction is complete merely because a preview overlay appears.

---

## 14. Phased implementation order

### Phase R1 — Contracts, policy, and pure utilities

Implement strict local schemas, placeholder allocation, string sanitization utilities, geometry/padding/clipping, and mask merging.

Acceptance:

- Unit tests cover malformed rectangles, overlapping masks, tile intersections, placeholders, maximum limits, and no raw text in sanitized output.
- No UI, manifest, network, or server changes yet.

### Phase R2 — OCR and DOM PII pipeline

Normalize OCR and DOM text, reconstruct split OCR spans, run deterministic rules, produce local text replacements and masks.

Acceptance:

- Synthetic emails, phone numbers, PAN/card-like values, labels, and instruction text are replaced locally.
- A split OCR email produces one redaction region spanning all relevant word boxes.
- DOM input values remain uncollected.

### Phase R3 — Visual masks and tiled redacted images

Add faces and future document findings to the plan. Redact capture tiles using separate bounded canvases and encode a newly generated redacted output.

Acceptance:

- No original image bytes appear in the redacted output.
- Face and OCR masks align at zoom 100%, 125%, DPR 1, and DPR 2.
- A mask crossing a tile seam is present in all affected tiles.
- Original preview is unchanged; export preview is redacted.

### Phase R4 — Value vault and version-1 payload builder

Build local approved-value references and construct the existing `StepRequestSchema` object. No transport yet.

Acceptance:

- Schema validation succeeds for a safe fixture request.
- JSON serialization contains no fixture PII, original Base64 screenshot, raw OCR, or local mapping.
- Wrong target/origin/task/expired reference is rejected.

### Phase R5 — Final gateway and review UI

Connect plan creation to the panel after detector completion. Add user-visible redaction status and final gateway blocking.

Acceptance:

- Detector/mask/encoding failure blocks output.
- Stop, retry, preview opt-out, page change, and panel disposal clear all redaction state.
- A safe request can be inspected locally but is not transmitted yet.

### Phase R6 — Approved future transport integration

Only after the privacy stage is independently verified and a server endpoint is authorized: add one background-worker transport path that accepts only a gateway-approved `StepRequest`.

Acceptance:

- Request inspection proves no raw PII leaves the extension.
- Transport errors do not retain or resend raw data.
- No component bypasses the gateway.

---

## 15. Required test matrix

Use only fictional/synthetic PII in fixtures and assertions.

### Unit tests

- Email/phone/PAN/Aadhaar/card/token/password candidate handling.
- Luhn-valid and Luhn-invalid card numbers.
- OCR words split across spaces, lines, and tile seams.
- Unicode/normalization behavior and maximum string lengths.
- DOM coordinate conversion at scroll, zoom, viewport offset, and DPR variations.
- Face/document/OCR overlap merging and padding.
- Tile-local clipping and full visual coverage at seams.
- Opaque output-mask pixels; no transparent masks.
- Payload string-leak scan rejects raw known fixture values.
- Schema rejection for unknown payload keys and over-limit Base64.
- Value-vault expiration, invalidation, wrong target, wrong origin, wrong task, and prohibited credential references.

### Browser tests

- A full-page fixture with PII above/below fold and across tile boundaries.
- OCR-visible PII absent from DOM text.
- Face plus document plus text overlap.
- 100%, 125%, and DPR 2 coordinate alignment.
- Long-page masking without webpage scrolling or focus movement.
- Detector timeout/failure/incomplete coverage blocks visual export.
- Stop during OCR, masking, and encoding prevents any delayed output.
- Scan again after Stop works cleanly.
- Changing page, scrolling, zooming, or switching tab invalidates output.
- Inspected extension storage, logs, and intercepted outgoing requests do not contain original images, raw fixture PII, or value mappings.

### Manual review

- Inspect the original local preview and redacted export preview side by side.
- Confirm all masks cover complete characters/faces/documents, including padded edges.
- Confirm error states explain why export is blocked without exposing sensitive text.
- Test narrow side-panel layout and keyboard access.

Passing synthetic tests demonstrates only bounded behavior; it is not a universal proof that no PII can ever be missed.

---

## 16. Non-negotiable implementation rules

1. No server request before the final gateway validates a sanitized request.
2. No original screenshot fallback.
3. No raw PII in logs, persistent storage, telemetry, URLs, errors, or payload previews.
4. No browser action executor in this workstream.
5. No automatic assumption that zero detections means zero PII.
6. No silently ignored detector/mask failures; block or explicitly withhold the affected context.
7. No raw input-value collection merely to make the server planner more capable.
8. Preserve current active-tab/origin/observation/generation invalidation rules.
9. Keep memory bounded for long pages and release buffers on all lifecycle exits.
10. Validate source schemas and final payload schemas at runtime.

---

## 17. Definition of done

The redaction engine is ready for a separate transport/action phase only when all of the following are true:

- It creates a safe, schema-valid version-1 request from the synthetic page.
- All exported text is sanitized and all exported pixels come from a newly encoded opaque-masked image.
- The request contains no raw fixture PII, original screenshots, raw OCR, raw DOM values, or local value mappings.
- Incomplete detection, invalid coordinates, oversized image output, page changes, and cancellation fail closed.
- Long-page, zoom, DPR, tile seam, Stop/retry, and lifecycle tests pass.
- The user can inspect the outgoing redacted representation before a future send.
- The implementation changes only privacy/redaction-related code, documentation, and tests required for this scope.

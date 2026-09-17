# Incremental multimodal privacy work

## Inspection and gap analysis (before implementation)

The workspace already contained the redaction implementation, including uncommitted files. This work extends it; it does not replace the engine.

| Responsibility | Existing implementation |
| --- | --- |
| Text rules, canonicalization, Luhn | `extension/src/privacy/classify.ts` |
| Placeholder consistency and conservative vocabulary | `extension/src/privacy/text.ts` |
| OCR worker and word boxes | `extension/src/vision/ocr/{tesseract,tesseract.worker,normalize}.ts` |
| MediaPipe worker and face geometry | `extension/src/vision/face/` |
| DOM metadata and invalidation | `extension/src/dom/{observe,content}.ts` |
| OCR reconstruction and region fusion | `extension/src/privacy/normalize.ts` |
| Padding, merging and coordinate conversion | `extension/src/privacy/geometry.ts` |
| Capture bands and inference crops | `extension/src/capture/{observe,tiles}.ts`, `extension/src/vision/page.ts` |
| Opaque tile masking and PNG encoding | `extension/src/privacy/image.ts` |
| Explicit profile approval and opaque references | `extension/src/privacy/value-vault.ts` |
| Final gateway and serialization allowlist | `extension/src/privacy/{gateway,payload,contracts}.ts`, `extension/src/contracts.ts` |
| Separate raw/export previews | `extension/src/ui/preview.tsx`, `extension/src/privacy/review.tsx` |
| Existing regression coverage | `extension/tests/unit/privacy.test.ts`, `extension/tests/browser/privacy*.spec.ts` |

Already complete before this increment: conservative regex detection, local raw-value lifetime, opaque placeholders, strict all-OCR/control masking, padding, overlap merging, tile ownership/cropping, bounded summary export, vault restrictions, payload validation, cancellation, separate previews and encoded-pixel tests. The new panel defaults to sensitive-only masking to preserve useful page context; direct legacy callers retain strict masking.

Partially complete: document evidence had a schema and working mask path but no panel producer; normal and compact OCR passes could retain duplicate findings. DOM exported no control values or arbitrary attributes, but only viewport controls had geometry. The gateway validated state and serialized output but did not inspect encoded mask pixels in production.

Missing: supplemental text detection, an enabled document evidence producer, a model-independent document adapter, runtime pixel verification, optional sanitized-image OCR verification, and capture-age enforcement independent of export start.

Risk review found no raw screenshot/PII serialization path in the existing allowlisted payload. DOM/OCR disagreements were conservatively masked. Remaining risks were unobserved visual content, silent renderer/encoder defects, and old observations obtaining a fresh export timeout. Bounds, stale binding, detector failure and vault provenance protections remain fail-closed.

## Existing implementation preserved

No replacement masking engine, full-page canvas, OCR runtime, face model, network transport, action executor, profile storage or restoration API was added. Existing tile padding/merging, original screenshots, raw preview, vault authorization and version-1 wire fields remain. The review defaults to sensitive-only OCR masking to preserve ordinary page context. An explicit strict option restores all-text and unknown-container masking; direct and legacy callers retain that strict default.

## OpenRedaction comparison and integration

The existing detector already covers email, phone, Indian PAN/Aadhaar-like values/IFSC, Luhn cards, passports, credentials, names, addresses, DOB and confidential text. Those rules remain authoritative and are not filtered by an additional detector's confidence.

The pinned `@openredaction/core@1.1.5` catalog supplies six additions: checksum-validated IBAN, contextual US SSN, MAC addresses, Google API keys, Slack tokens and database credential URLs. Existing categories are reused: bank account, document, token and API key. No additional Indian patterns were necessary for this increment.

Published lite code was tested, not merely assumed browser-compatible: it imports Node's `createRequire`. The package is therefore used only by `scripts/openredaction.mjs` to reproducibly generate `vendor/openredaction/patterns.js`. That file contains the selected regexes plus pure upstream IBAN/SSN validators, with the MIT notice shipped in `dist/licenses`. It is 3,601 bytes before minification. Run `node scripts/openredaction.mjs --check` to check provenance against the installed pinned package. A narrow npm override preserves Tesseract 7 despite the package's unused optional Tesseract 5 peer.

The adapter executes these bounded patterns synchronously on the existing 16,000-character budget. It never instantiates a runtime redactor, creates restoration maps, caches raw text, logs matches or makes network calls. SSN contextual validation and IBAN country-length/mod-97 validation reduce false positives. IBAN "test/example" prose does not exempt a valid checksum. Library-wide context scoring is deliberately not used to clear existing candidates. Candidate confidence is an explicit local rule score, not a calibrated model probability.

Source: [OpenRedaction](https://github.com/sam247/openredaction), [MIT license](https://github.com/sam247/openredaction/blob/main/LICENSE).

## OCR mapping and detection fusion

The existing canonical word-offset reconstruction remains. Multi-line text maps character offsets back to intersecting source boxes. Findings retain detector provenance and text ranges. Overlapping spans become one placeholder; credentials retain withholding priority. Exact duplicate findings are suppressed. Sensitive-only mode skips compacting ordinary words together, which had produced false email matches, and keeps masks separate so nearby boxes do not merge into a large black rectangle. Strict mode keeps compact detection and the existing conservative mask merge. Every positively classified PII box remains covered in both modes.

## Document and visual detection

`vision/documents.ts` extends the existing document evidence contract. The panel enables `document_rules`, a conservative fallback:

- Collect image, SVG, canvas, video, embedded-document/frame, CSS-background and control containers across the page, including below the viewport. Export only geometry, category and rule confidence locally; labels/URLs/values do not enter this metadata.
- Recognize Aadhaar, PAN, passport, ID, financial/private-document, signature and QR cues. Strict mode masks unclassified visual containers too; context mode preserves generic images so unrelated page context remains visible. Specifically identified visual regions are masked in both modes.
- Reuse OCR. Specific document cues without a trustworthy boundary trigger a whole-page mask. Ordinary words such as “bank” or “statement” alone do not trigger this fallback.
- Bind document evidence to the observation. Truncated collection and invalid/off-page geometry block; no empty-success fallback is used after failure.

`DocumentVisionAdapter` and `inspectDocumentTiles` also accept real local model outputs when a compatible model becomes available. Strict normalized outputs contain category, source, confidence and tile-pixel bbox, without raw PII. The runner validates PNG dimensions before decoding, processes one tile at a time, translates every box to page coordinates, retains overlap-margin detections, limits resources, checks cancellation/timeouts and releases bitmaps. Low-confidence boxes still mask. No model weights or worker are falsely presented as installed.

Eka Care informed the separation between OCR words/boxes, classified entities and masking. Its visual detector targets signatures, stamps, QR/barcodes, face photos, fingerprints and logos rather than identifying entire Aadhaar/PAN cards. The implementation uses Ultralytics/PyTorch and `.pt` weights, not a ready browser module. Code is Apache-2.0; the visual model/dependency is AGPL-3.0; the documented LayoutLMv3 image-text weights have non-commercial/share-alike restrictions. Exact weight bytes could not be verified from the model host. Without a verified browser artifact, runtime and model size, those weights were not imported. [Implementation](https://github.com/eka-care/document-pii-redactor/blob/main/document_pii_redactor/image/yolo11m.py), [licenses](https://github.com/eka-care/document-pii-redactor#license).

## Verification and gateway

Before rendering, the gateway requires masks for every positively classified OCR PII finding and all face, document, form-control and selected visual-region boxes. Strict mode also requires masks for every OCR box. It decodes the newly encoded PNG into a bounded alpha-preserving canvas and verifies every masked pixel is opaque black.

The review offers optional OCR re-scan of the actual sanitized image using the existing local Tesseract adapter. Known residual PII, malformed/stale results, inference failure or timeout block. It is supplemental: resized OCR can miss content, so no claim of universal PII absence is made. Re-running face/model inference is unnecessary for verifying already known mask regions.

The existing final serialization check and StepRequestSchema still run. `capturedAt` is recorded at capture start, remains local and is required by the gateway; missing, future and expired timestamps block. Review expiration uses that original age. Optional ordinary image-generation failure can still withhold the image, but verification failures cannot become successful exports.

## Minimal payload example

```json
{
  "protocolVersion": 1,
  "requestId": "request_10000000-0000-4000-8000-000000000001",
  "taskId": "20000000-0000-4000-8000-000000000002",
  "observationId": "30000000-0000-4000-8000-000000000003",
  "sanitizedInstruction": "Send to [EMAIL_1]",
  "elements": [],
  "valueRefs": []
}
```

The optional `sanitizedImage` still carries only PNG MIME type and newly encoded base64. Approved references remain opaque and explicitly approved through the existing vault. Detailed findings, raw OCR, source screenshots, document labels, confidence maps, restoration maps and vault values never enter this payload. No redundant privacy metadata was added to the existing version-1 contract.

## Validation

New unit regressions cover added patterns and existing Indian rules, invalid checksums, overlapping credentials, duplicate suppression, OCR offsets and substitutions, document categories/seams/low confidence, missing mask coverage, stale document evidence, capture age and payload absence of raw values/metadata.

New browser regressions exercise the adapter over large tiled documents, adapter failures/cancellation, corrupted opaque/transparent encoded pixels, sanitized-output OCR success/failure/residual PII, and DOM attribute exclusion with offscreen visual coverage. Existing privacy, capture, face, scaling, lifecycle, storage/log/network and bounded-memory tests remain.

## Current limitations versus future features

Current: no trained visual document/signature/QR model is bundled. Context mode preserves ordinary OCR text and generic images for page context; detector misses can therefore leave sensitive content visible. Strict mode trades context for broader masking and can over-redact. Rules can miss CSS-generated/shadow content, text-only documents or content missed by OCR and DOM. English OCR and face detection retain their existing recall limits. Pixel verification proves masks were applied to known regions, not comprehensive semantic detection.

Future: review and package a licensed browser-compatible model behind the existing adapter, add more languages/semantic recall, and optionally add dedicated explicit profile approval UI. Backend transport and browser actions remain outside this phase.

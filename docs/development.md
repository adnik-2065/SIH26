# Development plan

Status: planning only. Build one complete workflow in small, testable steps, using Chrome first. Keep one active task and one tab. Component responsibilities and stack are in [architecture.md](architecture.md); all milestones follow [privacy.md](privacy.md).

## First complete prototype

The user asks, “Fill this form and submit it,” on a synthetic application portal. Test values come from a temporary local profile entered by the user; the model must not invent missing personal information. Login remains manual initially.

The extension observes DOM and visual content, filters private information, and sends sanitized context to the AI. The AI requests actions using local value references. The extension fills approved fields, asks for confirmation before submission, and verifies success. Include image-based PII and a face so local visual processing has a visible role.

```text
User instruction + screenshot + DOM
  → Local detection (rules + OCR + lightweight vision)
  → Redaction and local value references
  → Compact sanitized context builder
  → Final privacy gateway checks the complete outgoing payload
  → Server AI returns one structured action
  → Local validation → confirmation when required → execution
  → Verify outcome → observe again or finish
```

## Priorities

| Priority | Scope |
| --- | --- |
| P0: first complete prototype | Extension, capture, DOM, lightweight local vision, OCR, face detection for the demo, privacy filtering, token mapping, final export gate, basic payload preview, backend/model, validated actions, confirmation, stop control, tests, and timing measurements. |
| P1: strengthen the prototype | Better name/address detection, more layouts and language cases, dashboard polish, quantization and performance tuning against measured bottlenecks. |
| P2: expand scope | Intelligent local/server routing, Firefox support, and broader website coverage. |

Local vision is a core requirement, not a late optimization. Check WebGPU/WASM model compatibility early; deeper optimization can follow the baseline. Uncertain content must be withheld even before detection coverage improves.

## Milestones

| Milestone | Build | Ready when |
| --- | --- | --- |
| M1 – Extension shell | Side panel, task input, stop control, scoped permissions, and first synthetic test page. | The unpacked extension opens beside the demo page; no AI requests are made. |
| M2 – Observation | Visible screenshot, DOM roles/labels/positions, local element references, and observation IDs. | Capture remains local; DOM and screenshot refer to the same page state, with recapture if it changes. Start timing measurements. |
| M3 – Text privacy | DOM rules and patterns for sensitive fields, emails, phones, and ID/card-like values; filter the user instruction too. | Known synthetic cases are detected. Credentials are excluded from export by policy; uncertain fields are withheld. |
| M4 – Visual privacy | Local OCR plus lightweight visual processing, including face detection for the demo. | Image-only PII and faces are detected locally; unreadable regions and model failures are handled without export. Benchmark on the target laptop. |
| M5 – Redaction and mapping | Text placeholders, opaque pixel masks, and a temporary local value map. | Exported image pixels are replaced correctly under zoom/scroll; mappings stay local and are restricted to the task, website, and approved field. |
| M6 – Context and gateway | Compact payload builder, final verification, and a local payload preview. | The gateway checks exactly what will be sent, including the instruction and metadata. Residual detections or incomplete checks block the request. |
| M7 – API and action contract | FastAPI endpoint, request/action schemas, and fixed synthetic responses for testing. | A sanitized request reaches the backend; task/observation IDs and invalid messages are checked before adding a model. |
| M8 – AI planner | One offline-deployable open-weight model behind an adapter. | It uses sanitized context to return one permitted action; model choice and deployment requirements are documented. |
| M9 – Local action safety | Validate targets, scope, arguments, observation freshness, and value destinations; add confirmation. | Stale actions, unauthorized destinations, and page instructions attempting to override the task are rejected. Test with fixed responses first. |
| M10 – Execution | Click, fill, scroll, select, wait, and done; resolve approved local references. | Individual actions work on fixtures, missing values prompt the user, and submission requires approval. Verify outcomes before retrying. |
| M11 – Complete loop | Observe, protect, request, validate, act, and verify repeatedly. | The form workflow succeeds; stop/time/step limits work; navigation or interrupted state causes re-observation; uncertain submission is not repeated automatically. |
| M12 – Evaluation and demo | Unseen layouts, failure cases, performance tuning, and dashboard polish. | Show a successful workflow, visual redaction, and a safe stop, supported by recorded measurements. |

Begin with M1 and M2, then M3–M6 before enabling AI traffic. Tests accompany every milestone; M12 expands evaluation rather than starting it.

## Important implementation choices

- Use `capture/` and `dom/` for observation, `vision/` for models/OCR, `privacy/` for filtering and mapping, `agent/` for validation/execution, and `metrics/` for measurements. Server folders are parts of one FastAPI backend.
- Keep selectors and private-value mappings local. Export task-scoped element IDs and only necessary sanitized descriptions. Include sanitized visual context when needed, rather than uploading a full screenshot every step.
- Redact passwords completely; do not offer reusable password/OTP references to the planner. Clear ordinary private-value mappings at task end and keep them out of logs.
- Use opaque image masks for the prototype. Check the final encoded image, not just an overlay. A second scan reduces risk but does not establish that no sensitive information remains.
- Keep observation separate from actions: READ is part of observation, not an unrestricted server command. Add navigation only with explicit destination validation and permission handling.
- Use the same validator for local shortcuts and server actions. A clear button label alone does not make a click safe.
- Show actual outgoing payloads early. Keep original previews local and opt-in; use synthetic data for the demo. Dashboard counts are diagnostics, not proof of zero leakage.

## Testing and measurements

Create fixtures in `tests/fixtures/` as each feature arrives: login fields, registration details, synthetic banking fields, image text, faces, and a mixed page. Use fake credentials and identifiers. Add Hindi/mixed text, zoom, dynamic layouts, malicious page instructions, wrong token destinations, stale actions, and model/network failures. Reserve some layouts for evaluation.

| Area | Record |
| --- | --- |
| Perception | Element identification/localization and target accuracy |
| Privacy | Detection precision/recall per category, exposed sensitive content, unnecessary masking, blocked exports |
| Leakage | Synthetic private content found in actual outgoing text/images and logs, including failure paths |
| Task success | Completed workflows, failures, unsafe or duplicate actions |
| Efficiency | Model size, cold start, median/p95 step latency, peak memory, payload size |

Compare DOM-only, vision-only, and combined perception on the same tasks. Record hardware, browser, model version, and sample count. Use browser/OS profiling tools for CPU/GPU and memory measurements. Set numeric targets after the first baseline; zero observed leaks in a test set is not a universal guarantee.

## Everyday development

Choose one behavior, implement the smallest change, check the fixture and relevant failure paths, record the result, and commit a working increment. Run the backend locally and load the built extension unpacked in Chrome. Add setup commands when configuration files exist. Keep React with plain CSS and direct model calls; no database or agent framework is needed initially.

Defer general PDF/video automation, multiple simultaneous tasks, accounts, and a large local language model. Hand control back for unsupported pages, browser dialogs, CAPTCHA, or uncertain targets.

Reference: [Official SIH statement](https://sih.gov.in/sih2026PS), entry SIH26171, requires browser-local vision and an end-to-end task; its evaluation weights are 25% visual accuracy, 20% PII detection, 20% redaction, 20% client resources, and 15% latency.

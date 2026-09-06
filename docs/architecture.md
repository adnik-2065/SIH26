# Architecture

This is the proposed design; none of the components are implemented yet.

## Main flow

```text
User task
  → Local task and page observation
  → DOM + local vision/OCR
  → Privacy filtering of task, text, and images
  → Final export check
  → Sanitized context sent to server AI
  → One structured action returned
  → Local validation and approval when required
  → Execute, verify result, and observe again
```

Simple commands such as scrolling can stay local, using the same action validator.

## Responsibilities

| Part | Job |
| --- | --- |
| `extension/src/ui/` | Show task progress, outgoing context, approval, and stop control. |
| `extension/src/background/` | Coordinate extension messages and the single server communication path through the service worker. |
| `extension/src/capture/` | Capture screenshots locally, invoked through the background component. |
| `extension/src/dom/` | Read visible page structure, labels, and element references through content scripts. |
| `extension/src/vision/` | Run local vision and OCR in dedicated workers hosted by an extension document; use an offscreen document where needed. |
| `extension/src/privacy/` | Sanitize exported content, mask image pixels, and keep private-value references locally. |
| `extension/src/agent/` | Track observations, validate actions, execute browser interactions through content scripts, and verify outcomes. |
| `extension/src/metrics/` | Collect timings and available resource measurements without recording private content. |
| `server/api/` | Receive sanitized requests and return structured responses. |
| `server/agent/` | Plan the next action using sanitized context and the model adapter. |
| `server/models/` | Load or connect to the selected model and run inference. |
| `server/schemas/` | Define and validate request and action formats. |
| `server/utils/` | Hold small helpers shared by server components when needed. |

The server has no direct browser access. These folders group responsibilities; they do not represent separate services. Model weights are not committed to `server/models/`.

Chrome service workers may stop between events and cannot access the DOM. Re-observe before resuming interrupted work; do not depend on worker globals for task continuity. See [Chrome service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers) and [offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen).

## Proposed stack

| Area | Choice |
| --- | --- |
| Extension | Chrome Manifest V3, TypeScript |
| UI and build | React, plain CSS, Vite, npm |
| Local inference | ONNX Runtime Web; WebGPU when supported, WASM fallback |
| OCR | Benchmark Tesseract.js as the initial candidate |
| Image masking | Canvas API |
| Sensitive-data detection | DOM rules and patterns, then a small local NER model and face detector as needed |
| Backend | Python, FastAPI, Pydantic; virtual environment and pip |
| Server reasoning | One offline-deployable open-weight model behind a small adapter |
| Transport | JSON over HTTP on localhost; HTTPS for remote deployment |
| Storage | Temporary local task state; no database for the MVP |

Choose exact model weights after measuring accuracy, startup time, memory, and latency on the target laptop. Check model licenses and actual WebGPU/WASM compatibility. Bundle executable JS/WASM with the extension; do not rely on CDN runtime code.

References: [Vite](https://vite.dev/guide/), [FastAPI](https://fastapi.tiangolo.com/), [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/), [Tesseract.js](https://github.com/naptha/tesseract.js), [Chrome remote-code policy](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).

## Client/server contract

- Request: task ID, observation ID, sanitized instruction, permitted element descriptions, and sanitized visual context when needed.
- Response: matching task/observation IDs, one allowed action, target reference, and permitted arguments.
- Start with click, scroll, fill, select, wait, and done. Navigation stays within approved task scope.
- Private form values use task-scoped local references; the server never receives the mapping.
- Reject unknown fields/actions, stale observations, and invalid targets. Never execute model-generated JavaScript.
- Check the expected page outcome after acting. Do not automatically repeat a submission after a timeout.

Detailed schemas will be added when implementation begins.

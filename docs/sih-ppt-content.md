# SIH26 — Privacy-Conscious Browser AI Agent

**Problem Statement:** SIH26171 — On-device Visual Perception for Light-weight Browser Agents  
**Current Demo:** Full-page capture, DOM observation, local English OCR, face detection, and visual review  
**Planned Completion:** PII/document detection, redaction, privacy gateway, reasoning server, and safe browser actions

## 1. Project / Proposed Solution

- A Chrome extension that can understand a webpage, protect private data, and safely complete browser tasks.
- Solves the privacy and safety risks of sending raw screenshots, personal data, and unrestricted actions to cloud agents.
- Core idea: **Observe locally → Protect locally → Plan securely → Act with approval.**
- Initial workflow: fill and submit a synthetic application form using a temporary local user profile.
- Login remains manual; missing personal information is never invented.

**Main Modules**

- **Observation:** Full-page screenshot and visible DOM controls — implemented.
- **Local Vision:** Tesseract OCR and MediaPipe face detection — implemented.
- **Privacy Layer:** PII/document detection, local references, and pixel redaction — planned.
- **Reasoning Server:** Returns one structured action at a time — planned.
- **Safe Executor:** Validates, confirms, executes, and verifies actions — planned.

## 2. How Our Solution Addresses the Problem

| Existing Problem | Our Solution |
| --- | --- |
| DOM-only agents miss text inside images and other visual content. | Combine DOM controls with full-page screenshot analysis. |
| Uploading raw webpages or screenshots can expose private data. | Run OCR and vision locally; export only checked, sanitized context. |
| A remote AI may receive real names, IDs, or form values. | Keep values on-device and send only task-scoped references. |
| Free-form AI output can produce unsafe browser actions. | Accept only strict actions: click, fill, select, scroll, wait, or done. |
| Page changes can make an old action incorrect. | Bind every result and action to the current observation ID. |
| Submit or payment-like actions may have serious effects. | Require local confirmation, revalidation, and outcome verification. |

## 3. Technical Approach

- **Input:** User task, current webpage, DOM controls, full rendered-page screenshot, and approved local profile.
- **Capture:** Chrome captures the full scrollable page without scrolling the live webpage.
- **Local Processing:** The page is divided into overlapping sections for bounded processing.
- **AI/CV:** Tesseract.js reads English text; MediaPipe BlazeFace locates faces.
- **Parallel Workers:** OCR and face detection run locally in separate reusable Web Workers.
- **Structured Results:** Text, confidence, faces, and bounding boxes use original screenshot coordinates.
- **Privacy Processing — planned:** Detect sensitive text/documents, replace text with references, and mask image pixels.
- **Backend — planned:** Send a sanitized JSON request to FastAPI and a local model through Ollama.
- **Safe Output — planned:** Validate one returned action, ask for approval when required, execute, and verify.

## 4. Technology Stack

**Frontend / Extension**

- Chrome Manifest V3, React, TypeScript, plain CSS, Vite

**Browser and Processing**

- Chrome APIs: Side Panel, `activeTab`, Scripting, Storage, Debugger/CDP
- DOM content scripts, Canvas, ImageBitmap, Web Workers, WebAssembly

**AI / ML**

- Tesseract.js 7 with bundled English data
- MediaPipe Tasks Vision 1.0.1 with bundled BlazeFace model
- Trained document/PII detector — planned; model/runtime not yet finalized

**Validation and Data Layer**

- Zod runtime schemas and generated JSON Schema
- In-memory screenshots/results and `chrome.storage.session` metadata
- No database required for the MVP

**Backend / APIs — planned**

- Python, FastAPI, Pydantic, Ollama, one local open-weight model
- Authenticated `GET /health` and `POST /agent/step`; JSON over HTTPS

**Deployment / Infrastructure**

- Laptop 1: Chrome extension and local vision
- Laptop 2: FastAPI, Ollama, and reasoning model — planned
- HTTPS connection through ngrok — planned; all runtime vision assets are bundled locally

## 5. Workflow / System Flow

```text
Input: User task + webpage + approved temporary local profile
↓
Full-page screenshot capture + DOM observation
↓
Local OCR + face detection in overlapping page sections
↓
Sensitive-text and document detection + local value references [Planned]
↓
Text replacement + opaque pixel redaction [Planned]
↓
Final privacy gateway checks the complete payload [Planned]
↓
Sanitized request → FastAPI/Ollama planner [Planned]
↓
One structured action → local validation → user approval if required [Planned]
↓
Execute action → verify result → observe again or finish [Planned]
↓
Output: Completed browser task without sending raw private context to the planner
```

**One-line Flow**

`Task + Page → Local Observation → Local Vision → Privacy Protection → Secure Planning → Validated Action → Approval → Execution + Verification`

## 6. Uniqueness and Innovation

- **Full-page multimodal perception:** Fuses DOM structure with screenshot text and face locations.
- **On-device visual intelligence:** OCR and face detection run locally with no runtime CDN or remote inference.
- **Section-based processing:** Overlapping page sections preserve detections across boundaries and limit memory use.
- **Private-value references:** The planner can request a value without receiving the actual personal value.
- **Fail-closed privacy gateway:** Incomplete inspection or redaction failure blocks the affected export — planned.
- **Observation-bound action loop:** One schema-validated action at a time, with freshness checks, approval, and result verification — planned.

## 7. Impact and Benefits

### Direct Benefits

- Detects webpage text, including image-only text, and faces on the user’s device.
- Reduces exposure of raw screenshots and personal information.
- Reduces manual reading and form-handling work after full-loop completion.
- Supports faster decisions using compact, task-relevant context.
- Prevents stale, unsupported, and blindly repeated actions.
- Gives users control through Stop, review, and confirmation steps.

### Long-Term Impact

- Safer adoption of browser agents for sensitive online workflows.
- Lower dependence on cloud vision services and central data storage.
- Modular expansion to ID documents, more languages, layouts, and websites.
- Reusable architecture for application and public-service portals.
- Better privacy, resource use, and auditability at scale.

## 8. Target Users / Stakeholders

- **Primary Users:** People completing browser-based application and service forms.
- **Beneficiaries:** Citizens, students, applicants, and users handling sensitive web content.
- **Organizations:** Government departments, institutions, and other online service providers.
- **Operational Stakeholders:** Portal administrators and browser-agent operators.
- **Technical Stakeholders:** AI/ML developers, extension developers, privacy teams, and security reviewers.

import { z } from 'zod';

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const target = { target: id };
// `fill`/`select` carry an opaque reference the extension minted, so the value
// stays local. `type`/`choose` carry literal server text, which is a weaker
// form: the executor refuses sensitive destinations and the text is classified
// before it is ever keyed into the page. `key` carries no text at all — it
// dispatches one Enter to the focused control, the path a real user takes when
// an autocomplete offers no clickable suggestion.
export const LiteralTextSchema = z.string().min(1).max(200);
export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), ...target }).strict(),
  z.object({ type: z.literal('fill'), ...target, valueRef: id }).strict(),
  z.object({ type: z.literal('type'), ...target, text: LiteralTextSchema }).strict(),
  z.object({ type: z.literal('select'), ...target, optionRef: id }).strict(),
  z.object({ type: z.literal('choose'), ...target, optionText: LiteralTextSchema }).strict(),
  z.object({ type: z.literal('scroll'), direction: z.enum(['up', 'down']), pixels: z.number().int().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(1).max(5000) }).strict(),
  // One Enter to the reviewed, focused element. Deliberately not an open key
  // vocabulary: only the key the autocomplete flow needs is accepted, so a
  // malformed value cannot reach the page as arbitrary synthetic input.
  z.object({ type: z.literal('key'), key: z.literal('Enter') }).strict(),
  // One browser history step back. Element-free like `key`: the reasoning
  // server decides the current page is a wrong destination and returns `back`
  // with no id; the executor performs what the user's own Back button would,
  // and the existing navigation pipeline supplies the fresh observation.
  z.object({ type: z.literal('back') }).strict(),
  z.object({ type: z.literal('done') }).strict(),
]);
export type Action = z.infer<typeof ActionSchema>;
const envelope = { protocolVersion: z.literal(1), requestId: id, taskId: id, observationId: id };
export const ActionResponseSchema = z.object({ ...envelope, action: ActionSchema }).strict();
// What the reasoning server actually returns. The server only ever received
// opaque element ids, so `id` is the single trusted way to address a control;
// `className`/`xpath` are tolerated on the wire and ignored, because a selector
// invented from a redacted screenshot would reach controls no reviewer saw.
export const AgentStepSchema = z.object({
  action: z.enum(['click', 'type', 'select', 'scroll', 'wait', 'finish', 'key', 'keypress', 'back']),
  id: z.string().max(100).nullable().optional(),
  className: z.string().max(300).nullable().optional(),
  xpath: z.string().max(1000).nullable().optional(),
  value: z.string().max(2000).nullable().optional(),
}).strict();
// `thought` is model prose for the user to read. It is never parsed for intent.
export const AgentResponseSchema = z.object({ thought: z.string().max(2000),
  output: z.array(AgentStepSchema).min(1).max(20),
  // Optional echo; when a server sends it, it must match the in-flight request.
  protocolVersion: z.literal(1).optional(), requestId: id.optional(), taskId: id.optional(), observationId: id.optional(),
}).strict();
// The privacy gateway creates this exact allowlist. No server transport exists.
// RectSchema is defined further down; the element schema below needs it, and
// const hoisting rules mean the schema must be constructed lazily here.
export const StepRequestSchema = z.object({ ...envelope,
  sanitizedInstruction: z.string().min(1).max(2000),
  elements: z.array(z.object({ id, role: z.string().max(50), description: z.string().max(300),
    // The control's box in the delivered screenshot's pixels, so a visible
    // control whose label the redaction replaced can be matched by position to
    // this exact existing id in page_info. Coordinates only — never a label,
    // href or attribute value.
    bounds: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative(), height: z.number().nonnegative() }).strict().optional(),
    // Credential-state only: whether a credential field (password, login
    // identifier) currently holds user input. A boolean, never the value.
    filled: z.boolean().optional() }).strict()).max(200),
  valueRefs: z.array(z.object({ id, purpose: z.string().max(100), target: id }).strict()).max(100),
  sanitizedImage: z.object({ mimeType: z.literal('image/png'), base64: z.string().max(4_000_000),
    // The delivered image's own pixel size. Element boxes in page_info are
    // expressed in this space so the model can match what it sees to exact
    // existing ids. Dimensions only — never another copy of the image.
    width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
}).strict();
export type StepRequest = z.infer<typeof StepRequestSchema>;

// ---------------------------------------------------------------------------
// Diagnostics
//
// A failure code on its own ("SERVER_UNREACHABLE") cannot say which stage of a
// request failed, whether anything was received, or who cancelled it. Every
// layer that can fail therefore reports this structured shape alongside its
// coarse category, so one failed run is readable end to end. It carries
// structure, never page content: sizes, counts, codes and states only.
export const ExtensionErrorSchema = z.object({
  code: z.string().min(1).max(80),
  stage: z.string().min(1).max(80),
  message: z.string().min(1).max(500),
  // What this failure is attributed to, in one short phrase.
  cause: z.string().max(200).optional(),
  // The original exception, as "Name: message". Never a stack trace.
  originalError: z.string().max(500).optional(),
  context: z.record(z.unknown()).optional(),
  timestamp: z.string(),
  runId: z.string().max(80).optional(),
}).strict();
export type ExtensionError = z.infer<typeof ExtensionErrorSchema>;

// The stages one agent request passes through. A failure names the stage it
// reached, which is what distinguishes "never left the device" from "the model
// answered and we could not read it".
export const TransportStageSchema = z.enum(['request_initialized', 'payload_serialized', 'fetch_started', 'response_received',
  'response_body_read_started', 'response_body_received', 'json_parse_started', 'json_parsed', 'reply_unwrapped',
  'response_validated', 'plan_validated', 'transport_completed']);
export type TransportStage = z.infer<typeof TransportStageSchema>;

export const TransportErrorCodeSchema = z.enum([
  'AGENT_ENDPOINT_REJECTED', 'AGENT_FETCH_ABORTED', 'AGENT_FETCH_TIMEOUT', 'AGENT_FETCH_NETWORK_ERROR',
  'AGENT_REDIRECT_BLOCKED', 'AGENT_HTTP_ERROR', 'AGENT_RESPONSE_READ_FAILED', 'AGENT_RESPONSE_EMPTY',
  'AGENT_RESPONSE_TOO_LARGE', 'AGENT_JSON_PARSE_FAILED', 'AGENT_MALFORMED_RESPONSE', 'AGENT_RESPONSE_SCHEMA_INVALID',
  'AGENT_PLAN_VALIDATION_FAILED', 'AGENT_UNKNOWN_ERROR']);
export type TransportErrorCode = z.infer<typeof TransportErrorCodeSchema>;
export type TransportError = ExtensionError & { code: TransportErrorCode; stage: TransportStage };

// Who cancelled a request, and why. An AbortError says only that something
// aborted; without this the panel cannot tell a 4-second task restart from a
// 120-second timeout, and both look like an unreachable server.
export const AbortSourceSchema = z.enum(['timeout', 'user_cancel', 'task_restart', 'task_replaced',
  'panel_unmount', 'pagehide', 'navigation', 'extension_shutdown', 'caller_signal', 'unknown']);
export type AbortSource = z.infer<typeof AbortSourceSchema>;
export const AbortReasonSchema = z.object({
  source: AbortSourceSchema, reason: z.string().max(200), at: z.string(),
  runId: z.string().max(80).optional(), stage: z.string().max(80).optional(),
}).strict();
export type AbortReason = z.infer<typeof AbortReasonSchema>;

export const RectSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative(), height: z.number().nonnegative() }).strict();
// The geometry a reviewed observation recorded for a control, shared by the
// panel→background and background→content ACT messages. One schema for both
// legs: the background forwards `expect` verbatim, so the two command schemas
// must never drift — a missing key here turns a valid click into
// INVALID_MESSAGE before any target validation runs (the CBE311 failure).
export const ExpectSchema = z.object({ role: z.string().max(50), bounds: RectSchema,
  // The viewport the observation was collected under. Chrome's capture
  // apparatus transiently shrinks the viewport; the executor uses this to
  // tell that harmless shift from a control that genuinely moved.
  viewport: z.object({ scrollX: z.number().finite(), scrollY: z.number().finite(),
    height: z.number().positive().finite() }).strict().optional() }).strict().optional();
export const PanelCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('STATUS') }).strict(),
  z.object({ type: z.literal('START'), instruction: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('OBSERVE') }).strict(),
  z.object({ type: z.literal('STOP') }).strict(),
  // The panel owns the observation and the review, so it is the only caller
  // allowed to ask for execution. The worker still re-checks its own state.
  // `resolved` carries an approved vault value for a `fill`/`select`, resolved
  // by the panel at dispatch time. It crosses extension messaging only.
  z.object({ type: z.literal('ACT'), observationId: id, action: ActionSchema, resolved: LiteralTextSchema.optional(),
    expect: ExpectSchema }).strict(),
]);
export const ContentCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PREPARE_CAPTURE'), observationId: id }).strict(),
  z.object({ type: z.literal('FINISH_CAPTURE'), observationId: id }).strict(),
  z.object({ type: z.literal('COLLECT'), observationId: id }).strict(),
  z.object({ type: z.literal('CHECK'), observationId: id }).strict(),
  z.object({ type: z.literal('RELEASE') }).strict(),
  // `expect` is the geometry the reviewed observation described. The content
  // script compares it against the live element before touching the page.
  // `resolved` carries an approved vault value for a `fill`/`select`, resolved
  // by the panel at dispatch time. It crosses extension messaging only.
  z.object({ type: z.literal('ACT'), observationId: id, action: ActionSchema, resolved: LiteralTextSchema.optional(),
    expect: ExpectSchema }).strict(),
]);
export const VisualCategorySchema = z.enum(['aadhaar_card', 'pan_card', 'passport', 'identity_card',
  'financial_document', 'private_document', 'signature', 'qr_barcode', 'form_control', 'sensitive_image']);
export type VisualCategory = z.infer<typeof VisualCategorySchema>;
export const VisualRegionSchema = z.object({ category: VisualCategorySchema, bounds: RectSchema,
  confidence: z.number().finite().min(0).max(1) }).strict();
export const ElementSchema = z.object({
  id, role: z.string().max(50), label: z.string().max(200), type: z.string().max(50),
  disabled: z.boolean(), sensitive: z.boolean(), bounds: RectSchema,
  // Whether the control currently holds user input. Never the value itself.
  filled: z.boolean().optional(),
  // A credential field (password, one-time code, login identifier): the agent
  // must never type into it, and only its filled state may reach the server.
  credential: z.boolean().optional(),
}).strict();
export const DomSnapshotSchema = z.object({
  observationId: id, documentId: id, revision: z.number().int().nonnegative(), origin: z.string().url(),
  viewport: z.object({ width: z.number().positive(), height: z.number().positive(), scrollX: z.number(), scrollY: z.number(), devicePixelRatio: z.number().positive(), visualScale: z.number().positive(), offsetX: z.number(), offsetY: z.number() }).strict(),
  elements: z.array(ElementSchema).max(200), hiddenCount: z.number().int().nonnegative(), truncated: z.boolean(),
  visualRegions: z.array(VisualRegionSchema).max(500).optional(),
}).strict();
export type DomSnapshot = z.infer<typeof DomSnapshotSchema>;
export type ObservedElement = z.infer<typeof ElementSchema>;
export type Rect = z.infer<typeof RectSchema>;

// Capture stability deliberately has its own compact snapshot. The ordinary
// DOM observation contains labels, revision counters and visual detections
// that can change without making the screenshot unsafe. This shape contains
// only values used to decide whether the captured pixels still describe the
// page, and never contains page text.
export const StabilitySnapshotSchema = z.object({
  url: z.string().url().max(4096), documentId: id,
  documentWidth: z.number().nonnegative().finite(), documentHeight: z.number().nonnegative().finite(),
  scrollWidth: z.number().nonnegative().finite(), scrollHeight: z.number().nonnegative().finite(),
  viewportWidth: z.number().positive().finite(), viewportHeight: z.number().positive().finite(),
  scrollX: z.number().finite(), scrollY: z.number().finite(),
  totalElementCount: z.number().int().nonnegative(), interactiveElementCount: z.number().int().nonnegative(),
}).strict();
export type StabilitySnapshot = z.infer<typeof StabilitySnapshotSchema>;

export const MutationSummarySchema = z.object({
  total: z.number().int().nonnegative(), ignored: z.number().int().nonnegative(),
  significant: z.number().int().nonnegative(), categories: z.record(z.number().int().nonnegative()),
}).strict();
export type MutationSummary = z.infer<typeof MutationSummarySchema>;

// Only major changes retire a capture, so these are the only reasons it can
// report. Small DOM mutations, animations, class and style changes, counters,
// badges, re-renders and lazy updates are not page changes.
export const PageChangeReasonSchema = z.enum([
  'PAGE_CHANGED_NAVIGATION', 'PAGE_CHANGED_MAJOR_LAYOUT', 'PAGE_CHANGED_DOCUMENT_SIZE',
  'PAGE_CHANGED_TARGET_REMOVED', 'PAGE_CHANGED_UNKNOWN',
]);
export type PageChangeReason = z.infer<typeof PageChangeReasonSchema>;
export const PageChangedDetailSchema = ExtensionErrorSchema.extend({
  code: z.literal('PAGE_CHANGED'), stage: z.literal('Capture Stability'), cause: PageChangeReasonSchema,
}).strict();
export type PageChangedDetail = z.infer<typeof PageChangedDetailSchema>;
export const PageChangedSchema = z.object({
  type: z.literal('PAGE_CHANGED'), observationId: id, detail: PageChangedDetailSchema.optional(),
}).strict();

export const CaptureSnapshotResponseSchema = z.object({
  snapshot: DomSnapshotSchema, stability: StabilitySnapshotSchema, mutations: MutationSummarySchema,
}).strict();
export type CaptureSnapshotResponse = z.infer<typeof CaptureSnapshotResponseSchema>;
export const CapturePageChangedResponseSchema = z.object({
  error: z.literal('PAGE_CHANGED'), detail: PageChangedDetailSchema,
}).strict();
export const CaptureCheckResponseSchema = z.union([CaptureSnapshotResponseSchema, CapturePageChangedResponseSchema]);
export const ErrorCodeSchema = z.enum(['ACCESS_REQUIRED', 'PAGE_CHANGED', 'STOPPED', 'CAPTURE_FAILED', 'CAPTURE_TOO_LARGE',
  'INVALID_MESSAGE', 'BUSY', 'RESTARTED', 'TARGET_CHANGED', 'TARGET_UNSAFE', 'ACTION_FAILED']);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export const TaskStateSchema = z.object({
  status: z.enum(['idle', 'observing', 'paused', 'stopped', 'failed']),
  taskId: id.optional(), tabId: z.number().int().optional(), windowId: z.number().int().optional(),
  origin: z.string().optional(), observationId: id.optional(),
  generation: z.number().int().nonnegative(), error: ErrorCodeSchema.optional(), errorDetail: ExtensionErrorSchema.optional(),
}).strict();
export type TaskState = z.infer<typeof TaskStateSchema>;
// Screenshots travel separately so a long page never exceeds Chrome's message
// size limit. Coordinates and ownership bands are in original page-image pixels.
export const CaptureTileSchema = z.object({
  screenshot: z.string().startsWith('data:image/png;base64,').max(30_000_000),
  y: z.number().int().nonnegative(), width: z.number().int().positive().max(32_767),
  height: z.number().int().positive().max(32_767),
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
}).strict().refine(tile => tile.width * tile.height <= 32_000_000 && tile.y <= tile.start &&
  tile.start < tile.end && tile.end <= tile.y + tile.height);
export type CaptureTile = z.infer<typeof CaptureTileSchema>;
export const CaptureObservationSchema = z.object({
  dom: DomSnapshotSchema, captureBounds: RectSchema,
  imageWidth: z.number().int().positive(), imageHeight: z.number().int().positive(),
  tileCount: z.number().int().positive().max(2048),
  captureMs: z.number().nonnegative(), domMs: z.number().nonnegative(),
  capturedAt: z.number().int().nonnegative().optional(),
}).strict();
export type CaptureObservation = z.infer<typeof CaptureObservationSchema>;
export interface LocalObservation extends CaptureObservation { tiles: CaptureTile[] }
export const PanelEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('STATE'), state: TaskStateSchema }).strict(),
  z.object({ type: z.literal('CAPTURE_TILE'), state: TaskStateSchema,
    index: z.number().int().nonnegative().max(2047), count: z.number().int().positive().max(2048), tile: CaptureTileSchema,
  }).strict(),
  z.object({ type: z.literal('OBSERVATION'), state: TaskStateSchema, observation: CaptureObservationSchema }).strict(),
]);

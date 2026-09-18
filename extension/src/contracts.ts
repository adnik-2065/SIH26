import { z } from 'zod';

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const target = { target: id };
// `fill`/`select` carry an opaque reference the extension minted, so the value
// stays local. `type`/`choose` carry literal server text, which is a weaker
// form: the executor refuses sensitive destinations and the text is classified
// before it is ever keyed into the page.
export const LiteralTextSchema = z.string().min(1).max(200);
export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), ...target }).strict(),
  z.object({ type: z.literal('fill'), ...target, valueRef: id }).strict(),
  z.object({ type: z.literal('type'), ...target, text: LiteralTextSchema }).strict(),
  z.object({ type: z.literal('select'), ...target, optionRef: id }).strict(),
  z.object({ type: z.literal('choose'), ...target, optionText: LiteralTextSchema }).strict(),
  z.object({ type: z.literal('scroll'), direction: z.enum(['up', 'down']), pixels: z.number().int().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(1).max(5000) }).strict(),
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
  action: z.enum(['click', 'type', 'select', 'scroll', 'wait', 'finish']),
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
export const StepRequestSchema = z.object({ ...envelope,
  sanitizedInstruction: z.string().min(1).max(2000),
  elements: z.array(z.object({ id, role: z.string().max(50), description: z.string().max(300) }).strict()).max(200),
  valueRefs: z.array(z.object({ id, purpose: z.string().max(100), target: id }).strict()).max(100),
  sanitizedImage: z.object({ mimeType: z.literal('image/png'), base64: z.string().max(4_000_000) }).strict().optional(),
}).strict();
export type StepRequest = z.infer<typeof StepRequestSchema>;

export const RectSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative(), height: z.number().nonnegative() }).strict();
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
    expect: z.object({ role: z.string().max(50), bounds: RectSchema }).strict().optional() }).strict(),
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
    expect: z.object({ role: z.string().max(50), bounds: RectSchema }).strict().optional() }).strict(),
]);
export const PageChangedSchema = z.object({ type: z.literal('PAGE_CHANGED'), observationId: id }).strict();
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
export const ErrorCodeSchema = z.enum(['ACCESS_REQUIRED', 'PAGE_CHANGED', 'STOPPED', 'CAPTURE_FAILED', 'CAPTURE_TOO_LARGE',
  'INVALID_MESSAGE', 'BUSY', 'RESTARTED', 'TARGET_CHANGED', 'TARGET_UNSAFE', 'ACTION_FAILED']);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export const TaskStateSchema = z.object({
  status: z.enum(['idle', 'observing', 'paused', 'stopped', 'failed']),
  taskId: id.optional(), tabId: z.number().int().optional(), windowId: z.number().int().optional(),
  origin: z.string().optional(), observationId: id.optional(),
  generation: z.number().int().nonnegative(), error: ErrorCodeSchema.optional(),
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

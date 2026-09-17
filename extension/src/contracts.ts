import { z } from 'zod';

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const target = { target: id };
export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), ...target }).strict(),
  z.object({ type: z.literal('fill'), ...target, valueRef: id }).strict(),
  z.object({ type: z.literal('select'), ...target, optionRef: id }).strict(),
  z.object({ type: z.literal('scroll'), direction: z.enum(['up', 'down']), pixels: z.number().int().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(1).max(5000) }).strict(),
  z.object({ type: z.literal('done') }).strict(),
]);
const envelope = { protocolVersion: z.literal(1), requestId: id, taskId: id, observationId: id };
export const ActionResponseSchema = z.object({ ...envelope, action: ActionSchema }).strict();
// The privacy gateway creates this exact allowlist. No server transport exists.
export const StepRequestSchema = z.object({ ...envelope,
  sanitizedInstruction: z.string().min(1).max(2000),
  elements: z.array(z.object({ id, role: z.string().max(50), description: z.string().max(300) }).strict()).max(200),
  valueRefs: z.array(z.object({ id, purpose: z.string().max(100), target: id }).strict()).max(100),
  sanitizedImage: z.object({ mimeType: z.literal('image/png'), base64: z.string().max(4_000_000) }).strict().optional(),
}).strict();

export const PanelCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('STATUS') }).strict(),
  z.object({ type: z.literal('START'), instruction: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('OBSERVE') }).strict(),
  z.object({ type: z.literal('STOP') }).strict(),
]);
export const ContentCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PREPARE_CAPTURE'), observationId: id }).strict(),
  z.object({ type: z.literal('FINISH_CAPTURE'), observationId: id }).strict(),
  z.object({ type: z.literal('COLLECT'), observationId: id }).strict(),
  z.object({ type: z.literal('CHECK'), observationId: id }).strict(),
  z.object({ type: z.literal('RELEASE') }).strict(),
]);
export const PageChangedSchema = z.object({ type: z.literal('PAGE_CHANGED'), observationId: id }).strict();
export const RectSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative(), height: z.number().nonnegative() }).strict();
export const VisualCategorySchema = z.enum(['aadhaar_card', 'pan_card', 'passport', 'identity_card',
  'financial_document', 'private_document', 'signature', 'qr_barcode', 'form_control', 'sensitive_image']);
export type VisualCategory = z.infer<typeof VisualCategorySchema>;
export const VisualRegionSchema = z.object({ category: VisualCategorySchema, bounds: RectSchema,
  confidence: z.number().finite().min(0).max(1) }).strict();
export const ElementSchema = z.object({
  id, role: z.string().max(50), label: z.string().max(200), type: z.string().max(50),
  disabled: z.boolean(), sensitive: z.boolean(), bounds: RectSchema,
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
export const ErrorCodeSchema = z.enum(['ACCESS_REQUIRED', 'PAGE_CHANGED', 'STOPPED', 'CAPTURE_FAILED', 'CAPTURE_TOO_LARGE', 'INVALID_MESSAGE', 'BUSY', 'RESTARTED']);
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

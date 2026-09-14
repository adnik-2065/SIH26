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
// A future export contract only. Phase 1 has no builder, gateway, or server transport.
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
export const ElementSchema = z.object({
  id, role: z.string().max(50), label: z.string().max(200), type: z.string().max(50),
  disabled: z.boolean(), sensitive: z.boolean(), bounds: RectSchema,
}).strict();
export const DomSnapshotSchema = z.object({
  observationId: id, documentId: id, revision: z.number().int().nonnegative(), origin: z.string().url(),
  viewport: z.object({ width: z.number().positive(), height: z.number().positive(), scrollX: z.number(), scrollY: z.number(), devicePixelRatio: z.number().positive(), visualScale: z.number().positive(), offsetX: z.number(), offsetY: z.number() }).strict(),
  elements: z.array(ElementSchema).max(200), hiddenCount: z.number().int().nonnegative(), truncated: z.boolean(),
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
export interface LocalObservation { dom: DomSnapshot; screenshot: string; captureBounds: Rect; imageWidth: number; imageHeight: number; captureMs: number; domMs: number; }
export const PanelEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('STATE'), state: TaskStateSchema }).strict(),
  z.object({ type: z.literal('OBSERVATION'), state: TaskStateSchema, observation: z.object({
    dom: DomSnapshotSchema, screenshot: z.string().startsWith('data:image/png;base64,').max(30_000_000),
    captureBounds: RectSchema,
    imageWidth: z.number().positive(), imageHeight: z.number().positive(), captureMs: z.number().nonnegative(), domMs: z.number().nonnegative(),
  }).strict() }).strict(),
]);

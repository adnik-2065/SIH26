import { z } from 'zod';
import { CaptureObservationSchema, CaptureTileSchema, StepRequestSchema, VisualCategorySchema } from '../contracts';
import type { ExtensionError, StepRequest } from '../contracts';
export type { StepRequest };
import { PerceptionResultSchema } from '../vision/contracts';

// Local resource budgets, independent of the version-1 wire contract.
export const LIMITS = Object.freeze({ text: 16_000, findings: 20_000, masks: 20_000,
  regions: 10_000, tiles: 2048, sourcePixels: 32_000_000, summaryPixels: 1_000_000,
  summarySide: 1600, imageBytes: 3_000_000, base64: 4_000_000, ttlMs: 300_000 });
export const IdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
export const BoundsSchema = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(),
  width: z.number().finite().positive(), height: z.number().finite().positive() }).strict();
export const PiiKindSchema = z.enum(['person_name', 'email', 'phone', 'address', 'date_of_birth', 'aadhaar', 'pan',
  'passport', 'payment_card', 'bank_account', 'ifsc', 'face', 'document', 'password', 'otp', 'token', 'api_key']);
export type PiiKind = z.infer<typeof PiiKindSchema>;
export const FindingSchema = z.object({ id: IdSchema, source: z.enum(['ocr', 'face', 'dom', 'document', 'instruction']),
  detector: z.enum(['openredaction', 'mediapipe', 'vision_model', 'document_rules']).optional(),
  textRange: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict().optional(),
  kind: PiiKindSchema, confidence: z.number().finite().min(0).max(1), text: z.string().max(LIMITS.text).optional(),
  bounds: BoundsSchema.optional(), elementId: IdSchema.optional(), exportPolicy: z.enum(['replace', 'mask', 'withhold', 'block']),
  redactText: z.boolean(), redactPixels: z.boolean(), unclassified: z.boolean().optional() }).strict();
export type Finding = z.infer<typeof FindingSchema>;
export const MaskSchema = z.object({ bounds: BoundsSchema, reasons: z.array(PiiKindSchema).min(1).max(19) }).strict();
export type Mask = z.infer<typeof MaskSchema>;
// Why an export was refused. The gateway still fails closed on every one of
// these; the difference is that each now names the evidence that was missing or
// the rule that fired, instead of one word covering seven unrelated causes.
// The two generic values are kept for third-party paths that still raise them.
export const BlockReasonSchema = z.enum(['STALE_OBSERVATION', 'STOPPED', 'INVALID_INPUT',
  'INCOMPLETE_DETECTION',
  'INCOMPLETE_DETECTION_OCR', 'INCOMPLETE_DETECTION_FACE', 'INCOMPLETE_DETECTION_DOCUMENT',
  'INCOMPLETE_DETECTION_OBSERVATION', 'INCOMPLETE_DETECTION_TILE', 'INCOMPLETE_DETECTION_BINDING',
  'INCOMPLETE_DETECTION_STALE_EVIDENCE', 'DOCUMENT_DETECTION_FAILED',
  'INVALID_BOUNDS',
  'TEXT_WITHHELD',
  'TEXT_WITHHELD_POLICY', 'TEXT_WITHHELD_INVALID_ENCODING', 'TEXT_WITHHELD_UNSAFE_CONTROL_CHARACTER',
  'TEXT_WITHHELD_SANITIZATION_FAILED',
  'LIMIT_EXCEEDED', 'MASKING_FAILED', 'IMAGE_TOO_LARGE', 'RAW_DATA_LEAK', 'INVALID_REFERENCE', 'VERIFICATION_FAILED']);
export type BlockReason = z.infer<typeof BlockReasonSchema>;
// The pipeline stage a refusal belongs to, for the panel and the run log.
export type PrivacyStage = 'PRIVACY_GATEWAY' | 'PRIVACY_NORMALIZATION' | 'OCR' | 'FACE_DETECTION'
  | 'DOCUMENT_DETECTION' | 'TILE_VALIDATION' | 'DOM_OBSERVATION';
export class PrivacyError extends Error {
  constructor(public readonly reason: BlockReason, public readonly detail?: ExtensionError) { super(reason); }
}
// Structure only: counts, statuses, identifiers, code points and lengths. No
// page text, OCR output, instruction or image data may enter `context`.
export function privacyError(reason: BlockReason, stage: PrivacyStage, message: string,
  context?: Record<string, unknown>, cause?: string): PrivacyError {
  return new PrivacyError(reason, { code: reason, stage, message, timestamp: new Date().toISOString(),
    ...(cause ? { cause } : {}), ...(context ? { context } : {}) });
}
const complete = z.enum(['complete', 'incomplete']);
export const CoverageSchema = z.object({ instruction: complete, dom: complete, ocr: complete, faces: complete,
  documents: z.enum(['not_enabled', 'complete', 'incomplete']), image: z.enum(['not_requested', 'complete', 'incomplete']) }).strict();
export const RedactionPlanSchema = z.object({ observationId: IdSchema, findings: z.array(FindingSchema).max(LIMITS.findings),
  masks: z.array(MaskSchema).max(LIMITS.masks), sanitizedInstruction: StepRequestSchema.shape.sanitizedInstruction,
  // Element boxes travel through the plan into page_info. The inferred type of
  // a strict() reference is the narrow id/role/description shape, so the schema
  // is stated explicitly to keep the bounds field visible to TypeScript.
  sanitizedElements: z.array(z.object({ id: IdSchema, role: z.string().max(50),
    description: z.string().max(300), bounds: BoundsSchema.optional() }).strict()).max(200),
  valueRefs: StepRequestSchema.shape.valueRefs,
  coverage: CoverageSchema, decision: z.enum(['safe', 'safe_without_image', 'blocked']), blockedReasons: z.array(BlockReasonSchema) }).strict();
export type RedactionPlan = z.infer<typeof RedactionPlanSchema>;
export const BindingSchema = z.object({ taskId: IdSchema, observationId: IdSchema, origin: z.string().url(),
  documentId: IdSchema, revision: z.number().int().nonnegative(), generation: z.number().int().nonnegative(),
  tabId: z.number().int().nonnegative() }).strict();
export type Binding = z.infer<typeof BindingSchema>;
// inspectCapturedPage aggregates bounded per-inference results. Validate the same
// region contract with a separate explicit page limit; never truncate that array.
const PageResultSchema = PerceptionResultSchema.extend({ regions: PerceptionResultSchema.shape.regions.max(LIMITS.regions) });
export const DetectorSchema = z.object({ status: complete, result: PageResultSchema.optional(),
  completedTiles: z.number().int().nonnegative().max(LIMITS.tiles), truncated: z.boolean() }).strict();
export type Detector = z.infer<typeof DetectorSchema>;
export const DocumentEvidenceSchema = z.object({ status: z.enum(['not_enabled', 'complete', 'incomplete']), required: z.boolean(),
  detector: z.enum(['document_rules', 'vision_model']).optional(),
  observationId: IdSchema, regions: z.array(z.object({ kind: z.enum(['document', 'aadhaar', 'pan', 'passport', 'payment_card']),
    category: VisualCategorySchema.optional(),
    bounds: BoundsSchema, confidence: z.number().finite().min(0).max(1) }).strict()).max(500) }).strict();
export const LocalObservationSchema = CaptureObservationSchema.extend({ tiles: z.array(CaptureTileSchema).max(LIMITS.tiles) });
export const ExportDataSchema = z.object({ binding: BindingSchema, observation: LocalObservationSchema,
  instruction: z.string().min(1).max(2000), ocr: DetectorSchema, faces: DetectorSchema, documents: DocumentEvidenceSchema,
  ocrTextPolicy: z.enum(['all_text', 'sensitive_only']).optional(),
  image: z.enum(['none', 'optional', 'required']) }).strict();
export type ExportData = z.infer<typeof ExportDataSchema>;
export type ExportResult = { ok: true; request: StepRequest; decision: 'safe' | 'safe_without_image';
  summary: { text: number; faces: number; documents: number; masks: number }; withheldReasons: BlockReason[] }
  // `blockedDetails` carries the stage, cause and safe context for each reason.
  | { ok: false; blockedReasons: BlockReason[]; blockedDetails?: ExtensionError[] };

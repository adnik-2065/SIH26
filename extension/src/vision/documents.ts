import { z } from 'zod';
import { VisualCategorySchema, type LocalObservation } from '../contracts';
import type { PerceptionResult } from './contracts';
import { ocrDocumentCategory } from '../dom/visuals';
import { BoundsSchema, DocumentEvidenceSchema, LIMITS, PrivacyError } from '../privacy/contracts';
import { domBounds, validateBounds } from '../privacy/geometry';
import { bounded, pngBytes, validateTiles } from '../privacy/image';

export const VisionDocumentResultSchema = z.object({ observationId: z.string(), truncated: z.literal(false),
  detections: z.array(z.object({ type: VisualCategorySchema, source: z.literal('vision_model'),
    confidence: z.number().finite().min(0).max(1), bbox: BoundsSchema }).strict()).max(500),
  elapsedMs: z.number().finite().nonnegative().optional(),
}).strict();
export type DocumentEvidence = z.infer<typeof DocumentEvidenceSchema>;
export interface DocumentVisionAdapter {
  // Own and release this tile bitmap on success, failure and cancellation.
  // Implementations must use packaged local assets, preferably in a worker.
  inspect(input: { observationId: string; image: ImageBitmap }, signal: AbortSignal): Promise<z.infer<typeof VisionDocumentResultSchema>>;
}
const kind = (category: z.infer<typeof VisualCategorySchema>): DocumentEvidence['regions'][number]['kind'] =>
  category === 'aadhaar_card' ? 'aadhaar' : category === 'pan_card' ? 'pan' : category === 'passport' ? 'passport' : 'document';

// Enabled default: conservative visual-container detection plus existing OCR.
// Unknown images are masked too, so an absent/incorrect alt label cannot clear
// a signature, barcode or scanned document. This is not trained model inference.
export function detectLocalDocuments(observation: LocalObservation, ocr: PerceptionResult,
  textPolicy: 'all_text' | 'sensitive_only' = 'all_text'): DocumentEvidence {
  if (observation.dom.truncated || ocr.observationId !== observation.dom.observationId || ocr.source !== 'model') throw new PrivacyError('INCOMPLETE_DETECTION');
  const regions: DocumentEvidence['regions'] = (observation.dom.visualRegions ?? [])
    .filter(region => textPolicy === 'all_text' || region.category !== 'sensitive_image').map(region => ({
    kind: kind(region.category), category: region.category, confidence: region.confidence,
    bounds: domBounds(region.bounds, observation),
  }));
  // OCR gives cues, not a trustworthy document boundary. When a cue exists,
  // mask the full captured page rather than inventing a smaller document box.
  // This also protects documents spanning many tiles and their non-text marks.
  const text = ocr.regions.map(region => region.text ?? '').join(' ');
  if (text.length > LIMITS.text) throw new PrivacyError('LIMIT_EXCEEDED');
  const category = ocrDocumentCategory(text);
  if (category) regions.push({ kind: kind(category), category, confidence: .5,
    bounds: { x: 0, y: 0, width: observation.imageWidth, height: observation.imageHeight } });
  return DocumentEvidenceSchema.parse({ status: 'complete', required: true, detector: 'document_rules',
    observationId: observation.dom.observationId, regions });
}

export function mergeDocumentEvidence(base: DocumentEvidence, model: DocumentEvidence): DocumentEvidence {
  if (base.observationId !== model.observationId || base.status !== 'complete' || model.status !== 'complete') throw new PrivacyError('INCOMPLETE_DETECTION');
  const regions = [...base.regions];
  for (const region of model.regions) {
    const duplicate = regions.some(existing => existing.category === region.category &&
      overlap(existing.bounds, region.bounds) >= .6);
    if (!duplicate) regions.push(region);
  }
  return DocumentEvidenceSchema.parse({ ...base, detector: 'vision_model', regions });
}

function overlap(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return intersection / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}

// Optional model boundary; deliberately independent of YOLO and masking.
// Keep every crop's boxes, including overlap margins. Center ownership can
// discard a truncated document that is visible in only one crop.
export async function inspectDocumentTiles(observation: LocalObservation, adapter: DocumentVisionAdapter,
  signal: AbortSignal): Promise<DocumentEvidence> {
  validateTiles(observation);
  const regions: DocumentEvidence['regions'] = [];
  const check = () => { if (signal.aborted) throw new PrivacyError('STOPPED'); };
  const observationId = observation.dom.observationId;
  for (const tile of observation.tiles) {
    check();
    let image: ImageBitmap | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 90_000);
    try {
      const bytes = pngBytes(tile.screenshot, tile.width, tile.height);
      image = await bounded(createImageBitmap(new Blob([bytes], { type: 'image/png' })), controller.signal, late => late.close()); check();
      if (image.width !== tile.width || image.height !== tile.height) throw new PrivacyError('INVALID_BOUNDS');
      // The adapter owns its model timeout and returns a detector-specific
      // error. Do not wrap it in the image helper, whose generic timeout code
      // would hide whether the ONNX worker failed or the PNG decode failed.
      const parsed = VisionDocumentResultSchema.safeParse(await adapter.inspect({ observationId, image }, controller.signal)); check();
      if (!parsed.success || parsed.data.observationId !== observationId) throw new PrivacyError('INCOMPLETE_DETECTION');
      for (const detection of parsed.data.detections) {
        const box = validateBounds(detection.bbox, tile.width, tile.height);
        // Low confidence is not permission to expose pixels.
        regions.push({ kind: kind(detection.type), category: detection.type, confidence: detection.confidence,
          bounds: { ...box, y: box.y + tile.y } });
      }
      if (regions.length > 500) throw new PrivacyError('LIMIT_EXCEEDED');
    } catch (error) {
      check(); throw error instanceof PrivacyError ? error : new PrivacyError('INCOMPLETE_DETECTION');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); image?.close(); }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  check();
  return DocumentEvidenceSchema.parse({ status: 'complete', required: true, detector: 'vision_model', observationId, regions });
}

import { z } from 'zod';
import { VisualCategorySchema, type LocalObservation, type Rect } from '../contracts';
import type { PerceptionResult } from './contracts';
import { ocrDocumentCue } from '../dom/visuals';
import { BoundsSchema, DocumentEvidenceSchema, LIMITS, privacyError, PrivacyError } from '../privacy/contracts';
import { domBounds, intersection, union, validateBounds } from '../privacy/geometry';
import { reconstructOcr } from '../privacy/normalize';
import { visualIsMasked, visualRegionIsEvidence } from '../privacy/policy';
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
  if (observation.dom.truncated) throw privacyError('INCOMPLETE_DETECTION_OBSERVATION', 'DOCUMENT_DETECTION',
    'The observation was truncated, so document evidence cannot cover the page.',
    { observationId: observation.dom.observationId, elements: observation.dom.elements.length }, 'dom.truncated');
  if (ocr.observationId !== observation.dom.observationId) throw privacyError('INCOMPLETE_DETECTION_BINDING', 'DOCUMENT_DETECTION',
    'Document rules were given text evidence from a different observation.',
    { observationId: observation.dom.observationId, evidenceObservationId: ocr.observationId }, 'observation id mismatch');
  if (ocr.source !== 'model') throw privacyError('INCOMPLETE_DETECTION_OCR', 'DOCUMENT_DETECTION',
    'Document rules require text evidence from the installed model.',
    { observationId: observation.dom.observationId, source: ocr.source }, 'result source is not the model');
  // Keep legitimate visual candidates, but never let a page-sized container
  // become a page-scale document mask: that is how a screenshot turned black.
  const regions: DocumentEvidence['regions'] = (observation.dom.visualRegions ?? [])
    .filter(region => visualIsMasked(region.category, textPolicy) && visualRegionIsEvidence(region.bounds, observation.captureBounds))
    .map(region => ({
    kind: kind(region.category), category: region.category, confidence: region.confidence,
    bounds: domBounds(region.bounds, observation),
  }));
  // OCR gives cues, not a trustworthy document boundary. One phrase is not
  // evidence for a page-scale rectangle, so both policies mask the lines the
  // cue actually sits on, widened across the capture: that is the largest
  // region the text evidence can justify. Identifiers elsewhere are still
  // caught by the text rules, and labelled or model-detected document regions
  // still cover the rest of a real document.
  const reconstructed = reconstructOcr(ocr.regions);
  if (reconstructed.text.length > LIMITS.text) throw new PrivacyError('LIMIT_EXCEEDED');
  const cue = ocrDocumentCue(reconstructed.text);
  if (cue) {
    const page: Rect = { x: 0, y: 0, width: observation.imageWidth, height: observation.imageHeight };
    // Every word box the cue touches, widened to the lines holding them.
    const boxes = reconstructed.spans.filter(span => span.start < cue.end && span.end > cue.start).map(span => span.bounds);
    if (boxes.length) {
      const bounds = { ...boxes.reduce(union), x: 0, width: observation.imageWidth };
      regions.push({ kind: kind(cue.category), category: cue.category, confidence: .5,
        bounds: validateBounds(bounds, page.width, page.height) });
    }
  }
  return DocumentEvidenceSchema.parse({ status: 'complete', required: true, detector: 'document_rules',
    observationId: observation.dom.observationId, regions });
}

export function mergeDocumentEvidence(base: DocumentEvidence, model: DocumentEvidence): DocumentEvidence {
  if (base.observationId !== model.observationId) throw privacyError('INCOMPLETE_DETECTION_BINDING', 'DOCUMENT_DETECTION',
    'Rule evidence and model evidence describe different observations.',
    { observationId: base.observationId, evidenceObservationId: model.observationId }, 'observation id mismatch');
  if (base.status !== 'complete' || model.status !== 'complete') throw privacyError('INCOMPLETE_DETECTION_DOCUMENT', 'DOCUMENT_DETECTION',
    'Document evidence cannot be merged before both sources complete.',
    { observationId: base.observationId, ruleStatus: base.status, modelStatus: model.status }, 'a source is not complete');
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
  for (const [tileIndex, tile] of observation.tiles.entries()) {
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
      if (!parsed.success) throw privacyError('DOCUMENT_DETECTION_FAILED', 'DOCUMENT_DETECTION',
        'The document model returned a result that does not match its contract.',
        { observationId, tileIndex, schema: 'VisionDocumentResultSchema' }, 'MODEL_RESULT_INVALID');
      if (parsed.data.observationId !== observationId) throw privacyError('INCOMPLETE_DETECTION_BINDING', 'DOCUMENT_DETECTION',
        'The document model answered for a different observation.',
        { observationId, evidenceObservationId: parsed.data.observationId, tileIndex }, 'observation id mismatch');
      for (const detection of parsed.data.detections) {
        const box = validateBounds(detection.bbox, tile.width, tile.height);
        const pageBox = { ...box, y: box.y + tile.y };
        // A detection covering essentially the whole capture describes the page
        // context, not a bounded document artefact. The same page-scale
        // evidence rule that gates DOM candidates gates model output, in image
        // space, so a false positive over ordinary UI can never become a
        // page-wide mask. Bounded detections still union across tile seams.
        if (!visualRegionIsEvidence(pageBox, { width: observation.imageWidth, height: observation.imageHeight })) continue;
        // The same document seen by neighbouring tiles arrives as one box per
        // crop. Union same-category intersecting boxes into one region: the
        // candidate list is deduplicated, while every crop's boxes keep their
        // combined coverage, so a document spanning a seam is never dropped
        // and never counted twice. Distinct same-category documents do not
        // intersect and stay separate.
        const existing = regions.find(region => region.category === detection.type && intersection(region.bounds, pageBox));
        if (existing) existing.bounds = union(existing.bounds, pageBox);
        else regions.push({ kind: kind(detection.type), category: detection.type, confidence: detection.confidence, bounds: pageBox });
        // eslint-disable-next-line no-console -- temporary runtime provenance diagnostic
        console.log('[DOC-PROBE] accepted', JSON.stringify({ category: detection.type, confidence: detection.confidence, pageBox, tile: { y: tile.y, width: tile.width, height: tile.height } }));
      }
      if (regions.length > 500) throw new PrivacyError('LIMIT_EXCEEDED');
    } catch (error) {
      check();
      if (error instanceof PrivacyError) throw error;
      // The model or the PNG decode threw. Keep what it said: "the document
      // detector failed" and "no document evidence exists" are different facts.
      throw privacyError('DOCUMENT_DETECTION_FAILED', 'DOCUMENT_DETECTION',
        'The local document model could not finish this tile.',
        { observationId, tileIndex, errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message.slice(0, 120) : undefined }, 'MODEL_EXECUTION_FAILED');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); image?.close(); }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  check();
  return DocumentEvidenceSchema.parse({ status: 'complete', required: true, detector: 'vision_model', observationId, regions });
}

import type { LocalObservation, Rect } from '../contracts';
import { PerceptionResultSchema, type PerceptionAdapter } from '../vision/contracts';
import { openRedactionCandidates } from './openredaction';
import { PrivacyError, type ExportData, type Finding, type Mask, type StepRequest } from './contracts';
import { pageFrame, visibleDomBounds } from './geometry';
import { compactKinds, reconstructOcr, textChunks } from './normalize';
import { controlIsMasked, visualIsMasked, visualRegionIsEvidence } from './policy';

export function verifyMaskCoverage(data: ExportData, masks: Mask[], findings: Finding[] = []) {
  const ocrBoxes = data.ocrTextPolicy === 'sensitive_only' ? [] : data.ocr.result!.regions;
  const expected = [...ocrBoxes, ...data.faces.result!.regions, ...data.documents.regions].map(r => r.bounds);
  expected.push(...findings.filter(finding => finding.redactPixels && finding.bounds).map(finding => finding.bounds!));
  const policy = data.ocrTextPolicy ?? 'all_text';
  // Only what the image shows can be expected under a mask.
  const visible = (bounds: Rect) => visibleDomBounds(bounds, data.observation) ?? [];
  expected.push(...data.observation.dom.elements.filter(e => controlIsMasked(e, policy)).flatMap(e => visible(e.bounds)));
  expected.push(...(data.observation.dom.visualRegions ?? [])
    .filter(r => visualIsMasked(r.category, policy) && visualRegionIsEvidence(r.bounds, pageFrame(data.observation)))
    .flatMap(r => visible(r.bounds)));
  for (const box of expected) if (!masks.some(({ bounds: b }) => b.x <= box.x && b.y <= box.y &&
    b.x + b.width >= box.x + box.width && b.y + b.height >= box.y + box.height)) throw new PrivacyError('VERIFICATION_FAILED');
}

// Inspect actual decoded PNG pixels, not canvas operations or status flags.
// One bounded output buffer; no source image or full-page canvas is allocated.
export function verifyOpaquePixels(context: OffscreenCanvasRenderingContext2D, masks: Mask[],
  observation: Pick<LocalObservation, 'imageWidth' | 'imageHeight'>, width: number, height: number, check: () => void) {
  const pixels = context.getImageData(0, 0, width, height).data;
  const sx = width / observation.imageWidth, sy = height / observation.imageHeight;
  for (const { bounds: b } of masks) {
    check();
    const left = Math.max(0, Math.floor(b.x * sx)), right = Math.min(width, Math.ceil((b.x + b.width) * sx));
    const top = Math.max(0, Math.floor(b.y * sy)), bottom = Math.min(height, Math.ceil((b.y + b.height) * sy));
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = (y * width + x) * 4;
      if (pixels[i] || pixels[i + 1] || pixels[i + 2] || pixels[i + 3] !== 255) throw new PrivacyError('VERIFICATION_FAILED');
    }
  }
}

export async function verifyWithOcr(image: NonNullable<StepRequest['sanitizedImage']>, observationId: string,
  adapter: PerceptionAdapter, signal: AbortSignal, check: () => void) {
  let bitmap: ImageBitmap | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    check();
    const work = async () => {
      bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(image.base64), c => c.charCodeAt(0))], { type: 'image/png' }));
      if (controller.signal.aborted) { bitmap.close(); throw new PrivacyError('VERIFICATION_FAILED'); }
      check();
      const width = bitmap.width, height = bitmap.height;
      const result = PerceptionResultSchema.safeParse(await adapter.inspect({ image: bitmap, observationId }, controller.signal));
      check();
      if (!result.success || result.data.observationId !== observationId || result.data.source !== 'model' ||
        result.data.regions.some(r => r.kind !== 'text' || !r.text || r.confidence === undefined || r.bounds.x < 0 || r.bounds.y < 0 ||
          r.bounds.width <= 0 || r.bounds.height <= 0 || r.bounds.x + r.bounds.width > width || r.bounds.y + r.bounds.height > height)) throw new PrivacyError('VERIFICATION_FAILED');
      for (const { text } of textChunks(reconstructOcr(result.data.regions).text)) {
        if (openRedactionCandidates(text).length || openRedactionCandidates(text.replace(/\s/g, '')).some(s => compactKinds.includes(s.kind))) throw new PrivacyError('VERIFICATION_FAILED');
      }
    };
    await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new PrivacyError('VERIFICATION_FAILED')); }, 30_000);
      controller.signal.addEventListener('abort', () => reject(new PrivacyError('VERIFICATION_FAILED')), { once: true });
    })]);
    check();
  } catch { check(); throw new PrivacyError('VERIFICATION_FAILED'); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); bitmap?.close(); }
}

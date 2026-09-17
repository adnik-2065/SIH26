import { BindingSchema, ExportDataSchema, LIMITS, PrivacyError, RedactionPlanSchema,
  type Binding, type ExportData, type ExportResult, type StepRequest, type BlockReason } from './contracts';
import { normalize } from './normalize';
import { redactImage, validateTiles } from './image';
import { finalCheck, payload } from './payload';
import { Placeholders } from './text';
import { sameBinding, type LocalValueVault } from './value-vault';
import { verifyMaskCoverage, verifyWithOcr } from './verification';
import type { PerceptionAdapter } from '../vision/contracts';

export interface ExportInput {
  data: ExportData;
  signal: AbortSignal;
  current: () => Binding | undefined;
  vault?: LocalValueVault;
  verificationOcr?: PerceptionAdapter;
}
export async function buildSafeStepRequest(input: ExportInput): Promise<ExportResult> {
  const placeholders = new Placeholders();
  const expiresAt = Date.now() + LIMITS.ttlMs;
  try {
    const parsed = ExportDataSchema.safeParse(input.data);
    if (!parsed.success) throw new PrivacyError('INVALID_INPUT');
    const data = parsed.data, { binding, observation } = data;
    const check = () => {
      if (input.signal.aborted) throw new PrivacyError('STOPPED');
      const current = BindingSchema.safeParse(input.current());
      if (Date.now() >= expiresAt || observation.capturedAt === undefined || Date.now() - observation.capturedAt >= LIMITS.ttlMs || observation.capturedAt > Date.now() ||
        !current.success || !sameBinding(binding, current.data) || observation.dom.observationId !== binding.observationId ||
        observation.dom.origin !== binding.origin || observation.dom.documentId !== binding.documentId || observation.dom.revision !== binding.revision) throw new PrivacyError('STALE_OBSERVATION');
    };
    check(); validateTiles(observation);
    if (observation.dom.truncated || data.documents.observationId !== binding.observationId || data.documents.status === 'incomplete' ||
      (data.documents.required && data.documents.status !== 'complete') ||
      (data.documents.status === 'not_enabled' && data.documents.regions.length)) throw new PrivacyError('INCOMPLETE_DETECTION');
    for (const detector of [data.ocr, data.faces]) if (detector.status !== 'complete' || detector.truncated ||
      detector.completedTiles !== observation.tileCount || !detector.result || detector.result.source !== 'model' ||
      detector.result.observationId !== binding.observationId || detector.result.regions.length >= LIMITS.regions) throw new PrivacyError('INCOMPLETE_DETECTION');
    const normalized = normalize(data, placeholders);
    const plan = RedactionPlanSchema.parse({ observationId: binding.observationId, ...normalized,
      valueRefs: input.vault?.references(binding) ?? [], coverage: { instruction: 'complete', dom: 'complete', ocr: 'complete', faces: 'complete',
        documents: data.documents.status, image: data.image === 'none' ? 'not_requested' : 'complete' },
      decision: data.image === 'none' ? 'safe_without_image' : 'safe', blockedReasons: [] });
    check();
    verifyMaskCoverage(data, plan.masks, plan.findings);
    let image: StepRequest['sanitizedImage'];
    const withheldReasons: BlockReason[] = [];
    if (data.image !== 'none') {
      try { image = await redactImage(observation, plan.masks, check, input.signal); }
      catch (error) {
        check();
        const reason = error instanceof PrivacyError ? error.reason : 'MASKING_FAILED';
        if (data.image === 'required' || !['MASKING_FAILED', 'IMAGE_TOO_LARGE'].includes(reason)) throw new PrivacyError(reason);
        withheldReasons.push(reason);
      }
    }
    check();
    if (image && input.verificationOcr) await verifyWithOcr(image, binding.observationId, input.verificationOcr, input.signal, check);
    const candidate = payload(binding, plan, placeholders, image);
    const request = finalCheck(candidate, plan.findings.flatMap(finding => finding.text ? [finding.text] : []), observation.tiles.map(tile => tile.screenshot), input.vault);
    check();
    // Return the *exact* validated object for local review. No transport exists.
    return { ok: true, request, decision: image ? 'safe' : 'safe_without_image', withheldReasons,
      summary: { text: plan.findings.filter(f => f.redactText).length, faces: plan.findings.filter(f => f.source === 'face').length,
        documents: plan.findings.filter(f => f.source === 'document').length, masks: plan.masks.length } };
  } catch (error) {
    input.vault?.clear();
    return { ok: false, blockedReasons: [error instanceof PrivacyError ? error.reason : 'INVALID_INPUT'] };
  } finally { placeholders.clear(); }
}

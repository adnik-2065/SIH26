import { BindingSchema, ExportDataSchema, LIMITS, PrivacyError, privacyError, RedactionPlanSchema,
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
  placeholders?: Placeholders;
  verificationOcr?: PerceptionAdapter;
}
// Fail-closed, unchanged: every condition below still refuses the export. What
// changed is that each one says which detector, which field, and what it saw,
// so "INCOMPLETE_DETECTION" no longer means seven different things.
function requireEvidence(data: ExportData, observationId: string, tileCount: number) {
  if (data.observation.dom.truncated) {
    throw privacyError('INCOMPLETE_DETECTION_OBSERVATION', 'PRIVACY_GATEWAY',
      'The observation did not describe the whole page, so it cannot be redacted safely.',
      { observationId, reason: 'dom.truncated', elements: data.observation.dom.elements.length,
        hiddenCount: data.observation.dom.hiddenCount }, 'control or region limit reached during collection');
  }
  // Strict mode masks every control's box, so it needs all of them on screen.
  if (data.observation.dom.omittedOnScreen && (data.ocrTextPolicy ?? 'all_text') === 'all_text') {
    throw privacyError('INCOMPLETE_DETECTION_OBSERVATION', 'PRIVACY_GATEWAY',
      'Strict masking needs every control on screen, and this screen had more links than the observation can list.',
      { observationId, reason: 'dom.omittedOnScreen', elements: data.observation.dom.elements.length,
        omittedOnScreen: data.observation.dom.omittedOnScreen }, 'on-screen link limit reached in strict mode');
  }
  const documents = data.documents;
  const documentContext = { observationId, detector: documents.detector ?? 'none', expectedStatus: 'complete',
    actualStatus: documents.status, required: documents.required, regions: documents.regions.length };
  if (documents.observationId !== observationId) {
    throw privacyError('INCOMPLETE_DETECTION_BINDING', 'DOCUMENT_DETECTION',
      'The document evidence belongs to a different observation.',
      { ...documentContext, evidenceObservationId: documents.observationId }, 'observation id mismatch');
  }
  if (documents.status === 'incomplete' || (documents.required && documents.status !== 'complete')) {
    throw privacyError('INCOMPLETE_DETECTION_DOCUMENT', 'DOCUMENT_DETECTION',
      'Document detection did not finish, so the export cannot be cleared.', documentContext,
      documents.status === 'incomplete' ? 'detector reported incomplete' : 'required detector did not report complete');
  }
  if (documents.status === 'not_enabled' && documents.regions.length) {
    throw privacyError('INCOMPLETE_DETECTION_DOCUMENT', 'DOCUMENT_DETECTION',
      'Document regions arrived from a detector that reported itself disabled.', documentContext, 'regions without an enabled detector');
  }
  for (const [name, detector, stage] of [['ocr', data.ocr, 'OCR'], ['face', data.faces, 'FACE_DETECTION']] as const) {
    const reason = name === 'ocr' ? 'INCOMPLETE_DETECTION_OCR' : 'INCOMPLETE_DETECTION_FACE';
    const context: Record<string, unknown> = { observationId, detector: name, expectedStatus: 'complete',
      actualStatus: detector.status, expectedTiles: tileCount, completedTiles: detector.completedTiles,
      truncated: detector.truncated, hasResult: !!detector.result, regions: detector.result?.regions.length ?? 0 };
    if (detector.status !== 'complete' || !detector.result) {
      throw privacyError(reason, stage, `${name === 'ocr' ? 'Text recognition' : 'Face detection'} did not finish.`,
        context, detector.result ? 'status is not complete' : 'detector produced no result');
    }
    if (detector.truncated || detector.completedTiles !== tileCount) {
      throw privacyError('INCOMPLETE_DETECTION_STALE_EVIDENCE', stage,
        `${name === 'ocr' ? 'Text recognition' : 'Face detection'} covered a different capture than the one being exported.`,
        context, detector.truncated ? 'detector truncated its output' : 'tile coverage does not match the capture');
    }
    if (detector.result.observationId !== observationId) {
      throw privacyError('INCOMPLETE_DETECTION_BINDING', stage,
        `${name === 'ocr' ? 'Text recognition' : 'Face detection'} evidence belongs to a different observation.`,
        { ...context, evidenceObservationId: detector.result.observationId }, 'observation id mismatch');
    }
    if (detector.result.source !== 'model') {
      throw privacyError(reason, stage, `${name === 'ocr' ? 'Text recognition' : 'Face detection'} evidence did not come from the installed model.`,
        { ...context, source: detector.result.source }, 'result source is not the model');
    }
    if (detector.result.regions.length >= LIMITS.regions) {
      throw privacyError(reason, stage, `${name === 'ocr' ? 'Text recognition' : 'Face detection'} hit its region limit, so its coverage is unknown.`,
        { ...context, limit: LIMITS.regions }, 'region limit reached');
    }
  }
}

export async function buildSafeStepRequest(input: ExportInput): Promise<ExportResult> {
  const placeholders = input.placeholders ?? new Placeholders();
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
    requireEvidence(data, binding.observationId, observation.tileCount);
    const stages = { pii: 0, masking: 0, verification: 0, payload: 0 };
    let mark = performance.now();
    const lap = (stage: keyof typeof stages) => { const now = performance.now(); stages[stage] += now - mark; mark = now; };
    const normalized = normalize(data, placeholders, input.vault);
    input.vault?.capture(normalized.findings, placeholders);
    const plan = RedactionPlanSchema.parse({ observationId: binding.observationId, ...normalized,
      valueRefs: input.vault?.references(binding) ?? [], coverage: { instruction: 'complete', dom: 'complete', ocr: 'complete', faces: 'complete',
        documents: data.documents.status, image: data.image === 'none' ? 'not_requested' : 'complete' },
      decision: data.image === 'none' ? 'safe_without_image' : 'safe', blockedReasons: [] });
    check(); lap('pii');
    verifyMaskCoverage(data, plan.masks, plan.findings);
    lap('verification');
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
    check(); lap('masking');
    if (image && input.verificationOcr) {
      // The re-scan reads the masked image back. What it still finds is often
      // a misread, and the image is optional: withholding it keeps the step
      // going on the sanitized text and controls, rather than stopping the run.
      try { await verifyWithOcr(image, binding.observationId, input.verificationOcr, input.signal, check); }
      catch (error) {
        check();
        if (data.image === 'required' || !(error instanceof PrivacyError) || error.reason !== 'VERIFICATION_FAILED') throw error;
        image = undefined; withheldReasons.push('VERIFICATION_FAILED');
      }
    }
    lap('verification');
    // Known values are the raw texts the detectors positively classified. Words
    // the allowlist merely could not clear are excluded: they are ordinary page
    // vocabulary, and on any real site they overlap the user's own instruction
    // ("lms", "attendance"), which would block every such request as a leak.
    const known = plan.findings.flatMap(finding => finding.text && !finding.unclassified ? [{ kind: finding.kind, text: finding.text }] : []);
    const policy = data.ocrTextPolicy ?? 'all_text';
    const { request: candidate, rewritten } = payload(binding, plan, placeholders, image, { known, vault: input.vault, policy });
    const request = finalCheck(candidate, known.map(value => value.text), observation.tiles.map(tile => tile.screenshot), input.vault, policy);
    if (rewritten) withheldReasons.push('TEXT_WITHHELD_POLICY');
    check(); lap('payload');
    // Return the *exact* validated object for local review. No transport exists.
    return { ok: true, request, decision: image ? 'safe' : 'safe_without_image', withheldReasons, stages,
      summary: { text: plan.findings.filter(f => f.redactText).length, faces: plan.findings.filter(f => f.source === 'face').length,
        documents: plan.findings.filter(f => f.source === 'document').length, masks: plan.masks.length, rewritten } };
  } catch (error) {
    input.vault?.clear();
    const failure = error instanceof PrivacyError ? error : undefined;
    const detail = failure?.detail ?? { code: failure?.reason ?? 'INVALID_INPUT', stage: 'PRIVACY_GATEWAY',
      message: 'The redacted export could not be produced.', timestamp: new Date().toISOString(),
      ...(error instanceof Error ? { cause: error.name } : {}) };
    return { ok: false, blockedReasons: [failure?.reason ?? 'INVALID_INPUT'], blockedDetails: [detail] };
  } finally { if (!input.placeholders) placeholders.clear(); }
}

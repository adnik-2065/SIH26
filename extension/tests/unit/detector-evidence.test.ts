import { describe, expect, it } from 'vitest';
import { buildSafeStepRequest } from '../../src/privacy/gateway';
import { detectLocalDocuments, mergeDocumentEvidence } from '../../src/vision/documents';
import { binding, fixture } from '../privacy-fixture';
import type { ExportData } from '../../src/privacy/contracts';

const run = (mutate: (data: ExportData) => void) => {
  const data = fixture();
  mutate(data);
  return buildSafeStepRequest({ data, signal: new AbortController().signal, current: () => binding });
};

// Every case here still fails closed. The assertions are about whether the
// refusal can be acted on: which detector, which field, and what it saw.
describe('why the privacy gateway refused', () => {
  it('accepts complete evidence', async () => {
    expect(await run(() => {})).toMatchObject({ ok: true });
  });
  it('names text recognition when OCR did not finish', async () => {
    expect(await run(data => { data.ocr.status = 'incomplete'; })).toMatchObject({ ok: false,
      blockedReasons: ['INCOMPLETE_DETECTION_OCR'],
      blockedDetails: [{ stage: 'OCR', context: { detector: 'ocr', expectedStatus: 'complete', actualStatus: 'incomplete' } }] });
  });
  it('names face detection when its evidence is missing', async () => {
    expect(await run(data => { delete data.faces.result; })).toMatchObject({ ok: false,
      blockedReasons: ['INCOMPLETE_DETECTION_FACE'],
      blockedDetails: [{ stage: 'FACE_DETECTION', cause: 'detector produced no result', context: { hasResult: false } }] });
  });
  it('separates evidence for another observation from evidence that is merely incomplete', async () => {
    expect(await run(data => { data.ocr.result!.observationId = '40000000-0000-4000-8000-000000000009'; })).toMatchObject({
      ok: false, blockedReasons: ['INCOMPLETE_DETECTION_BINDING'],
      blockedDetails: [{ cause: 'observation id mismatch', context: { evidenceObservationId: '40000000-0000-4000-8000-000000000009' } }] });
  });
  it('separates evidence that covered a different capture', async () => {
    expect(await run(data => { data.faces.completedTiles = 1; })).toMatchObject({ ok: false,
      blockedReasons: ['INCOMPLETE_DETECTION_STALE_EVIDENCE'],
      blockedDetails: [{ cause: 'tile coverage does not match the capture', context: { expectedTiles: 2, completedTiles: 1 } }] });
    expect(await run(data => { data.ocr.truncated = true; })).toMatchObject({ ok: false,
      blockedReasons: ['INCOMPLETE_DETECTION_STALE_EVIDENCE'], blockedDetails: [{ cause: 'detector truncated its output' }] });
  });
  it('refuses evidence that did not come from the installed model', async () => {
    expect(await run(data => { data.ocr.result!.source = 'mock'; })).toMatchObject({ ok: false,
      blockedReasons: ['INCOMPLETE_DETECTION_OCR'], blockedDetails: [{ cause: 'result source is not the model' }] });
  });
  it('names the document detector, and whether it was required', async () => {
    expect(await run(data => { data.documents = { ...data.documents, status: 'incomplete', required: true }; })).toMatchObject({
      ok: false, blockedReasons: ['INCOMPLETE_DETECTION_DOCUMENT'],
      blockedDetails: [{ stage: 'DOCUMENT_DETECTION', context: { required: true, actualStatus: 'incomplete' } }] });
  });
  it('refuses document regions from a detector that reported itself disabled', async () => {
    expect(await run(data => {
      data.documents = { ...data.documents, status: 'not_enabled', required: false,
        regions: [{ kind: 'document', bounds: { x: 1, y: 1, width: 10, height: 10 }, confidence: .9 }] };
    })).toMatchObject({ ok: false, blockedReasons: ['INCOMPLETE_DETECTION_DOCUMENT'],
      blockedDetails: [{ cause: 'regions without an enabled detector' }] });
  });
  it('names a truncated observation rather than blaming a detector', async () => {
    expect(await run(data => { data.observation.dom.truncated = true; })).toMatchObject({ ok: false,
      blockedReasons: ['INCOMPLETE_DETECTION_OBSERVATION'], blockedDetails: [{ cause: 'control or region limit reached during collection' }] });
  });
  it('lets a screen with left-out links through in context mode but refuses it in strict mode', async () => {
    expect(await run(data => { data.observation.dom.omittedOnScreen = 12; data.ocrTextPolicy = 'sensitive_only'; }))
      .toMatchObject({ ok: true });
    expect(await run(data => { data.observation.dom.omittedOnScreen = 12; data.ocrTextPolicy = 'all_text'; })).toMatchObject({
      ok: false, blockedReasons: ['INCOMPLETE_DETECTION_OBSERVATION'], blockedDetails: [{ cause: 'on-screen link limit reached in strict mode' }] });
  });
  it('keeps page content out of every refusal', async () => {
    const blocked = await run(data => { data.ocr.status = 'incomplete'; });
    expect(JSON.stringify(blocked)).not.toContain('mira@example.test');
    expect(JSON.stringify(blocked)).not.toContain('data:image');
  });
});

describe('when the document detector itself fails', () => {
  const observation = () => fixture().observation;
  const ocr = () => fixture().ocr.result!;
  it('reports a truncated observation as such', () => {
    const page = observation(); page.dom.truncated = true;
    expect(() => detectLocalDocuments(page, ocr())).toThrowError(
      expect.objectContaining({ reason: 'INCOMPLETE_DETECTION_OBSERVATION' }));
  });
  it('reports text evidence from another observation', () => {
    const stale = { ...ocr(), observationId: '40000000-0000-4000-8000-000000000009' };
    try {
      detectLocalDocuments(observation(), stale);
      throw new Error('expected a refusal');
    } catch (error) {
      const failure = error as { reason?: string; detail?: { stage?: string; cause?: string } };
      expect(failure.reason).toBe('INCOMPLETE_DETECTION_BINDING');
      expect(failure.detail).toMatchObject({ stage: 'DOCUMENT_DETECTION', cause: 'observation id mismatch' });
    }
  });
  it('refuses to merge rule and model evidence before both complete', () => {
    const base = { status: 'complete' as const, required: true, observationId: binding.observationId, regions: [] };
    try {
      mergeDocumentEvidence(base, { ...base, status: 'incomplete' });
      throw new Error('expected a refusal');
    } catch (error) {
      const failure = error as { reason?: string; detail?: { context?: Record<string, unknown> } };
      expect(failure.reason).toBe('INCOMPLETE_DETECTION_DOCUMENT');
      expect(failure.detail?.context).toMatchObject({ ruleStatus: 'complete', modelStatus: 'incomplete' });
    }
  });
});

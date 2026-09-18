import { describe, expect, it } from 'vitest';
import { classify } from '../../src/privacy/classify';
import { additionalTextCandidates } from '../../src/privacy/openredaction';
import { Placeholders, sanitizeText } from '../../src/privacy/text';
import { normalize, reconstructOcr } from '../../src/privacy/normalize';
import { verifyMaskCoverage } from '../../src/privacy/verification';
import { buildSafeStepRequest } from '../../src/privacy/gateway';
import { LIMITS } from '../../src/privacy/contracts';
import { detectLocalDocuments, VisionDocumentResultSchema } from '../../src/vision/documents';
import { tileMasks } from '../../src/privacy/geometry';
import { binding, fixture } from '../privacy-fixture';

describe('curated OpenRedaction additions', () => {
  it.each([
    ['bank_account', 'GB82 WEST 1234 5698 7654 32'],
    ['document', 'SSN: 321-54-6789'], ['token', 'AA:BB:CC:DD:EE:FF'],
    ['api_key', `AIza${'A'.repeat(35)}`], ['token', 'xoxb-1234567890-abcdef'],
    ['token', 'postgres://fictional:password@db.test/local'],
  ])('adds %s with local offsets and no raw-value fields', (kind, raw) => {
    const spans = additionalTextCandidates(raw);
    expect(spans.some(s => s.kind === kind && s.detector === 'openredaction')).toBe(true);
    expect(spans.every(s => s.start >= 0 && s.end <= raw.length)).toBe(true);
    expect(JSON.stringify(spans)).not.toContain(raw);
    expect(sanitizeText(raw, 'instruction').sanitized).not.toContain(raw);
  });
  it('rejects invalid IBAN checksums and ordinary structural prose', () => {
    expect(additionalTextCandidates('GB83 WEST 1234 5698 7654 32')).toEqual([]);
    expect(additionalTextCandidates('Please inspect the form')).toEqual([]);
    expect(additionalTextCandidates('test IBAN: GB82 WEST 1234 5698 7654 32')).toHaveLength(1);
  });
  it.each([
    ['email', 'mira@example.test'], ['phone', '+91 98765 43210'], ['pan', 'ABCDE1234F'],
    ['aadhaar', '1234 5678 9012'], ['payment_card', '4111 1111 1111 1111'],
    ['ifsc', 'ABCD0123456'], ['passport', 'A1234567'], ['api_key', 'API key: fictional-key'],
  ])('retains existing %s rules', (kind, raw) => {
    expect(classify(raw).some(s => s.kind === kind)).toBe(true);
    expect(sanitizeText(raw, 'instruction').sanitized).not.toContain(raw);
  });
  it('fuses overlapping existing and added credentials into one placeholder', () => {
    const raw = `AIza${'A'.repeat(35)}`;
    expect(classify(raw).length).toBeGreaterThan(1);
    const placeholders = new Placeholders();
    const first = sanitizeText(raw, 'instruction', placeholders);
    expect(first.findings).toHaveLength(1);
    expect(first.findings[0].exportPolicy).toBe('withhold');
    expect(sanitizeText(raw, 'element_description', placeholders).sanitized).toBe(first.sanitized);
  });
});

describe('OCR offsets and conservative fusion', () => {
  it('maps multi-token numbers across lines and punctuation to all source boxes', () => {
    const data = fixture();
    data.ocr.result!.regions = ['1234', '5678', '9012', ','].map((text, i) => ({ kind: 'text', text, confidence: .5,
      bounds: { x: i === 3 ? 50 : 10, y: 90 + Math.min(i, 2) * 10, width: i === 3 ? 4 : 40, height: 10 } }));
    const reconstructed = reconstructOcr(data.ocr.result!.regions);
    for (const span of reconstructed.spans) expect(reconstructed.text.slice(span.start, span.end)).not.toBe('');
    const plan = normalize(data, new Placeholders());
    const aadhaar = plan.findings.filter(f => f.source === 'ocr' && f.kind === 'aadhaar');
    expect(aadhaar).toHaveLength(1);
    expect(aadhaar[0].bounds).toEqual({ x: 10, y: 90, width: 40, height: 30 });
    expect(() => verifyMaskCoverage(data, plan.masks)).not.toThrow();
    for (const tile of data.observation.tiles) expect(tileMasks(plan.masks, tile).length).toBeGreaterThan(0);
  });
  it('keeps names, addresses and OCR substitutions masked even without a rule match', () => {
    const data = fixture();
    data.ocr.result!.regions = ['Mira', 'Fictional', '123', 'Example', 'Road', 'I234', '567B', '9O12'].map((text, i) =>
      ({ kind: 'text', text, confidence: .2, bounds: { x: 10, y: 40 + i * 15, width: 60, height: 10 } }));
    const plan = normalize(data, new Placeholders());
    expect(() => verifyMaskCoverage(data, plan.masks)).not.toThrow();
    expect(() => verifyMaskCoverage(data, [])).toThrow('VERIFICATION_FAILED');
  });
  it('sensitive-only mode keeps ordinary OCR context while covering every classified PII box', () => {
    const data = fixture();
    data.ocrTextPolicy = 'sensitive_only';
    data.observation.dom.visualRegions = [
      { category: 'sensitive_image', confidence: .5, bounds: { x: 130, y: 100, width: 40, height: 40 } },
      { category: 'signature', confidence: .8, bounds: { x: 130, y: 150, width: 40, height: 20 } },
    ];
    data.ocr.result!.regions = [
      { kind: 'text', text: 'Workshop application', confidence: .99, bounds: { x: 130, y: 40, width: 60, height: 12 } },
      { kind: 'text', text: 'mira@example.test', confidence: .99, bounds: { x: 10, y: 70, width: 100, height: 12 } },
    ];
    const plan = normalize(data, new Placeholders());
    data.documents = detectLocalDocuments(data.observation, data.ocr.result!, 'sensitive_only');
    expect(data.documents.regions.some(r => r.category === 'signature')).toBe(true);
    expect(data.documents.regions.some(r => r.category === 'sensitive_image')).toBe(false);
    expect(plan.findings.some(f => f.text === 'Workshop application')).toBe(false);
    expect(plan.findings.some(f => f.kind === 'email' && f.text === 'mira@example.test')).toBe(true);
    expect(plan.masks.some(m => m.bounds.x <= 130 && m.bounds.x + m.bounds.width >= 190 && m.bounds.y <= 40 && m.bounds.y + m.bounds.height >= 52),
      JSON.stringify(plan.masks.map(m => ({ bounds: m.bounds, reasons: m.reasons })))).toBe(false);
    expect(plan.masks.some(m => m.bounds.y <= 70 && m.bounds.y + m.bounds.height >= 82)).toBe(true);
    const withDocuments = normalize(data, new Placeholders());
    expect(() => verifyMaskCoverage(data, withDocuments.masks, withDocuments.findings)).not.toThrow();
  });
  it('suppresses identical OCR and DOM findings without shrinking covering masks', () => {
    const data = fixture();
    data.observation.dom.elements[0].label = 'mira@example.test';
    data.ocr.result!.regions = [{ kind: 'text', text: 'mira@example.test', confidence: 1,
      bounds: data.observation.dom.elements[0].bounds }];
    const plan = normalize(data, new Placeholders());
    expect(plan.findings.filter(f => f.kind === 'email' && f.bounds)).toHaveLength(1);
    expect(() => verifyMaskCoverage(data, plan.masks)).not.toThrow();
  });
});

describe('local document evidence and model boundary', () => {
  it.each(['aadhaar_card', 'passport', 'financial_document', 'signature', 'qr_barcode', 'sensitive_image'] as const)(
    'masks %s containers including low-confidence detections across tile seams', category => {
      const data = fixture();
      data.observation.dom.visualRegions = [{ category, confidence: .1, bounds: { x: 20, y: 80, width: 120, height: 60 } }];
      data.documents = detectLocalDocuments(data.observation, data.ocr.result!);
      const plan = normalize(data, new Placeholders());
      expect(data.documents.regions[0].bounds).toEqual(data.observation.dom.visualRegions[0].bounds);
      expect(plan.masks.some(m => m.bounds.y <= 80 && m.bounds.y + m.bounds.height >= 140)).toBe(true);
      for (const tile of data.observation.tiles) expect(tileMasks(plan.masks, tile).some(m => m.bounds.width >= 120)).toBe(true);
    });
  it('uses a whole-page fallback for document cues with no trusted document boundary', () => {
    const data = fixture();
    data.ocr.result!.regions[0].text = 'passport number';
    data.documents = detectLocalDocuments(data.observation, data.ocr.result!);
    expect(data.documents.regions[0].bounds).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    expect(normalize(data, new Placeholders()).masks).toHaveLength(1);
  });
  it('rejects stale evidence, truncated collection and raw model result fields', () => {
    const data = fixture();
    expect(() => detectLocalDocuments(data.observation, { ...data.ocr.result!, observationId: 'stale' })).toThrow();
    data.observation.dom.truncated = true;
    expect(() => detectLocalDocuments(data.observation, data.ocr.result!)).toThrow();
    expect(VisionDocumentResultSchema.safeParse({ observationId: 'x', truncated: true, detections: [] }).success).toBe(false);
    expect(VisionDocumentResultSchema.safeParse({ observationId: 'x', truncated: false, detections: [], rawText: 'secret' }).success).toBe(false);
  });
});

describe('freshness and minimal transport boundary', () => {
  it('blocks missing capture age and missing masks for known visual containers', async () => {
    const data = fixture(); delete data.observation.capturedAt;
    expect(await buildSafeStepRequest({ data, current: () => data.binding, signal: new AbortController().signal }))
      .toEqual({ ok: false, blockedReasons: ['STALE_OBSERVATION'] });
    data.observation.capturedAt = Date.now();
    data.observation.dom.visualRegions = [{ category: 'signature', confidence: .5, bounds: { x: 160, y: 160, width: 20, height: 20 } }];
    expect(await buildSafeStepRequest({ data, current: () => data.binding, signal: new AbortController().signal }))
      .toEqual({ ok: false, blockedReasons: ['VERIFICATION_FAILED'] });
  });
  it('blocks old and future capture timestamps', async () => {
    for (const capturedAt of [Date.now() - LIMITS.ttlMs - 1, Date.now() + 10000]) {
      const data = fixture(); data.observation.capturedAt = capturedAt;
      expect(await buildSafeStepRequest({ data, current: () => data.binding, signal: new AbortController().signal }))
        .toEqual({ ok: false, blockedReasons: ['STALE_OBSERVATION'] });
    }
  });
  it('exports no added-detector values, findings, document metadata or restoration map', async () => {
    const data = fixture(), raw = 'GB82 WEST 1234 5698 7654 32';
    data.instruction = `Send to ${raw}`;
    data.documents = detectLocalDocuments(data.observation, data.ocr.result!);
    const result = await buildSafeStepRequest({ data, current: () => data.binding, signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = JSON.stringify(result.request);
    for (const forbidden of [raw, 'redactionMap', 'findings', 'visualRegions', 'rawValue', 'textRange', 'detector']) expect(json).not.toContain(forbidden);
  });
});

describe('context mode masks private values, not the whole page', () => {
  // A form is a stack of controls. Masking all of them, padded, fused the rows
  // into one black slab that also swallowed their visible labels.
  const form = () => {
    const data = fixture();
    data.ocrTextPolicy = 'sensitive_only';
    data.observation.dom.elements = [
      { id: `${binding.observationId}_e1`, role: 'button', type: 'button', label: 'Change layout', sensitive: false, disabled: false, filled: false,
        bounds: { x: 10, y: 10, width: 80, height: 20 } },
      { id: `${binding.observationId}_e2`, role: 'textbox', type: 'text', label: 'Full name', sensitive: false, disabled: false, filled: false,
        bounds: { x: 10, y: 40, width: 100, height: 20 } },
      { id: `${binding.observationId}_e3`, role: 'textbox', type: 'tel', label: 'Phone number', sensitive: false, disabled: false, filled: true,
        bounds: { x: 10, y: 70, width: 100, height: 20 } },
      { id: `${binding.observationId}_e4`, role: 'textbox', type: 'password', label: 'Sensitive field', sensitive: true, disabled: false, filled: false,
        bounds: { x: 10, y: 100, width: 100, height: 20 } },
    ];
    data.faces.result!.regions = [];
    data.ocr.result!.regions = [{ kind: 'text', text: 'Workshop', confidence: .99, bounds: { x: 10, y: 150, width: 60, height: 10 } }];
    return data;
  };
  const covers = (masks: { bounds: { x: number; y: number; width: number; height: number } }[], box: { x: number; y: number; width: number; height: number }) =>
    masks.some(({ bounds: b }) => b.x <= box.x && b.y <= box.y && b.x + b.width >= box.x + box.width && b.y + b.height >= box.y + box.height);

  it('leaves empty controls and buttons visible while covering filled and secret ones', () => {
    const data = form();
    const plan = normalize(data, new Placeholders());
    expect(covers(plan.masks, data.observation.dom.elements[0].bounds)).toBe(false);
    expect(covers(plan.masks, data.observation.dom.elements[1].bounds)).toBe(false);
    expect(covers(plan.masks, data.observation.dom.elements[2].bounds)).toBe(true);
    expect(covers(plan.masks, data.observation.dom.elements[3].bounds)).toBe(true);
    // The gateway must accept exactly what the planner produced.
    expect(() => verifyMaskCoverage(data, plan.masks, plan.findings)).not.toThrow();
  });
  it('still covers every control in strict mode', () => {
    const data = form(); data.ocrTextPolicy = 'all_text';
    const plan = normalize(data, new Placeholders());
    for (const element of data.observation.dom.elements) expect(covers(plan.masks, element.bounds)).toBe(true);
    expect(() => verifyMaskCoverage(data, plan.masks, plan.findings)).not.toThrow();
  });
  it('withholds a control whose observation predates the filled flag', () => {
    const data = form();
    delete data.observation.dom.elements[1].filled;
    const plan = normalize(data, new Placeholders());
    expect(covers(plan.masks, data.observation.dom.elements[1].bounds)).toBe(true);
  });
  it('treats form controls and unlabelled images as context, not documents', () => {
    const data = form();
    data.observation.dom.visualRegions = [
      { category: 'form_control', confidence: .8, bounds: { x: 10, y: 40, width: 100, height: 20 } },
      { category: 'sensitive_image', confidence: .5, bounds: { x: 120, y: 40, width: 40, height: 40 } },
      { category: 'aadhaar_card', confidence: .8, bounds: { x: 120, y: 100, width: 40, height: 40 } },
    ];
    const documents = detectLocalDocuments(data.observation, data.ocr.result!, 'sensitive_only');
    expect(documents.regions.map(r => r.category)).toEqual(['aadhaar_card']);
    expect(detectLocalDocuments(data.observation, data.ocr.result!, 'all_text').regions).toHaveLength(3);
  });
  it('bounds an OCR document cue to its own lines instead of the whole capture', () => {
    const data = form();
    data.ocr.result!.regions = [
      { kind: 'text', text: 'Passport', confidence: .99, bounds: { x: 10, y: 150, width: 40, height: 10 } },
      { kind: 'text', text: 'number', confidence: .99, bounds: { x: 55, y: 150, width: 40, height: 10 } },
      { kind: 'text', text: 'Unrelated', confidence: .99, bounds: { x: 10, y: 20, width: 40, height: 10 } },
    ];
    const region = detectLocalDocuments(data.observation, data.ocr.result!, 'sensitive_only').regions[0];
    expect(region.category).toBe('passport');
    expect(region.bounds).toEqual({ x: 0, y: 150, width: 200, height: 10 });
    expect(detectLocalDocuments(data.observation, data.ocr.result!, 'all_text').regions[0].bounds)
      .toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });
});

import { describe, expect, it } from 'vitest';
import { openRedactionCandidates } from '../../src/privacy/openredaction';
import { Placeholders, sanitizeText } from '../../src/privacy/text';
import { normalize, reconstructOcr } from '../../src/privacy/normalize';
import { verifyMaskCoverage } from '../../src/privacy/verification';
import { buildSafeStepRequest } from '../../src/privacy/gateway';
import { LIMITS } from '../../src/privacy/contracts';
import { detectLocalDocuments, VisionDocumentResultSchema } from '../../src/vision/documents';
import { tileMasks } from '../../src/privacy/geometry';
import { binding, fixture } from '../privacy-fixture';

describe('OpenRedaction-derived candidates', () => {
  it.each([
    ['bank_account', 'GB82 WEST 1234 5698 7654 32'],
    ['document', 'SSN: 321-54-6789'], ['token', 'AA:BB:CC:DD:EE:FF'],
    ['api_key', `AIza${'A'.repeat(35)}`], ['token', 'xoxb-1234567890-abcdef'],
    ['token', 'postgres://fictional:password@db.test/local'],
  ])('adds %s with local offsets and no raw-value fields', (kind, raw) => {
    const spans = openRedactionCandidates(raw);
    expect(spans.some(s => s.kind === kind && s.detector === 'openredaction')).toBe(true);
    expect(spans.every(s => s.start >= 0 && s.end <= raw.length)).toBe(true);
    expect(JSON.stringify(spans)).not.toContain(raw);
    expect(sanitizeText(raw, 'instruction').sanitized).not.toContain(raw);
  });
  it('rejects invalid IBAN checksums and ordinary structural prose', () => {
    expect(openRedactionCandidates('GB83 WEST 1234 5698 7654 32')).toEqual([]);
    expect(openRedactionCandidates('Please inspect the form')).toEqual([]);
    expect(openRedactionCandidates('test IBAN: GB82 WEST 1234 5698 7654 32')).toHaveLength(1);
  });
  it('applies the engine\'s false-positive rules that judge the value itself', () => {
    expect(openRedactionCandidates('Card: 0000 0000 0000 0000')).toEqual([]);
    expect(openRedactionCandidates('Card: 4111 1111 1111 1111').map(s => s.kind)).toEqual(['payment_card']);
  });
  // The engine's other rules fire on a word anywhere in the \u00b150 character
  // window: 'bar@' as test data, 'https://' as a code comment, 'on' as a date.
  it.each(['Contact akbar@gmail.com', 'Visit https://lms.iitd.ac.in or mail asha.rao@gmail.com',
    'Call me on +44 20 7946 0958'])('keeps "%s", which a window-word rule would discard', raw => {
    expect(openRedactionCandidates(raw)).toHaveLength(1);
  });
  it('drops a match whose context score falls below the engine threshold', () => {
    // 0.8, less 0.15 for code-like text, 0.15 for example wording and 0.05 for
    // a technical word among the five before it, is 0.45; the same email in
    // plain text scores 0.65.
    expect(openRedactionCandidates('function const let var class import export return if else for while function const: mira@example.test')).toEqual([]);
    expect(openRedactionCandidates('Contact mira@example.test')).toMatchObject([{ kind: 'email', confidence: .65 }]);
  });
  it.each([
    ['email', 'mira@example.test'], ['phone', '9876543210'],
    ['aadhaar', 'Aadhaar: 2345 6789 0124'], ['payment_card', '4111 1111 1111 1111'],
    ['ifsc', 'IFSC: ABCD0123456'], ['passport', 'Passport: A1234567'], ['api_key', 'API key: fictional-key'],
  ])('detects %s through OpenRedaction', (kind, raw) => {
    expect(openRedactionCandidates(raw).some(s => s.kind === kind)).toBe(true);
    expect(sanitizeText(raw, 'instruction').sanitized).not.toContain(raw);
  });
  it('fuses every candidate for a value into one withheld placeholder', () => {
    const raw = `AIza${'A'.repeat(35)}`;
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
    data.ocr.result!.regions = ['Aadhaar', '2345', '6789', '0124'].map((text, i) => ({ kind: 'text', text, confidence: .5,
      bounds: { x: 10, y: 90 + Math.min(i, 2) * 10, width: 40, height: 10 } }));
    const reconstructed = reconstructOcr(data.ocr.result!.regions);
    for (const span of reconstructed.spans) expect(reconstructed.text.slice(span.start, span.end)).not.toBe('');
    const plan = normalize(data, new Placeholders());
    const aadhaar = plan.findings.filter(f => f.source === 'ocr' && f.kind === 'aadhaar');
    expect(aadhaar).toHaveLength(1);
    expect(aadhaar[0].bounds).toEqual({ x: 10, y: 100, width: 40, height: 20 });
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
  it('judges a viewport capture\'s visual regions against the whole page and drops those off screen', () => {
    const data = fixture();
    data.observation.dom.viewport = { ...data.observation.dom.viewport, height: 200, scrollY: 1000 };
    data.observation.captureBounds = { x: 0, y: 1000, width: 200, height: 200 };
    data.observation.pageSize = { width: 200, height: 2000 };
    data.observation.scope = 'viewport';
    data.observation.dom.visualRegions = [
      // Most of the screen, but a small part of the page: still a document.
      { category: 'passport', confidence: .9, bounds: { x: 10, y: 20, width: 180, height: 160 } },
      { category: 'signature', confidence: .9, bounds: { x: 20, y: 500, width: 60, height: 20 } },
    ];
    data.documents = detectLocalDocuments(data.observation, data.ocr.result!);
    expect(data.documents.regions.map(r => r.category)).toEqual(['passport']);
    expect(data.documents.regions[0].bounds).toEqual({ x: 10, y: 20, width: 180, height: 160 });
    const plan = normalize(data, new Placeholders());
    expect(plan.masks.some(m => m.bounds.y <= 20 && m.bounds.y + m.bounds.height >= 180 && m.bounds.width >= 180)).toBe(true);
    expect(() => verifyMaskCoverage(data, plan.masks, plan.findings)).not.toThrow();
  });
  it('bounds a document cue to its own lines in both policies, never the whole capture', () => {
    const data = fixture();
    data.ocr.result!.regions[0].text = 'passport number';
    data.documents = detectLocalDocuments(data.observation, data.ocr.result!, 'all_text');
    expect(data.documents.regions[0].bounds).toEqual({ x: 0, y: 90, width: 200, height: 10 });
    const plan = normalize(data, new Placeholders());
    expect(plan.masks.length).toBeGreaterThan(0);
    expect(plan.masks.every(m => m.bounds.height < data.observation.imageHeight)).toBe(true);
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
      .toMatchObject({ ok: false, blockedReasons: ['STALE_OBSERVATION'] });
    data.observation.capturedAt = Date.now();
    data.observation.dom.visualRegions = [{ category: 'signature', confidence: .5, bounds: { x: 160, y: 160, width: 20, height: 20 } }];
    expect(await buildSafeStepRequest({ data, current: () => data.binding, signal: new AbortController().signal }))
      .toMatchObject({ ok: false, blockedReasons: ['VERIFICATION_FAILED'] });
  });
  it('blocks old and future capture timestamps', async () => {
    for (const capturedAt of [Date.now() - LIMITS.ttlMs - 1, Date.now() + 10000]) {
      const data = fixture(); data.observation.capturedAt = capturedAt;
      expect(await buildSafeStepRequest({ data, current: () => data.binding, signal: new AbortController().signal }))
        .toMatchObject({ ok: false, blockedReasons: ['STALE_OBSERVATION'] });
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
  // Words OCR read with low confidence on google.com (a microphone icon, Indic
  // language links under the English model, a stylised link) and on
  // wikipedia.org (article counts). Only what OpenRedaction classifies is masked.
  it('masks a low-confidence OCR word only when OpenRedaction classifies it', () => {
    const data = form();
    const words = ['4', 'Ld', 'eet', 'pexwoge', 'Setings', 'birthday!', '2781', '000+', '8/88', 'mira@example.test'];
    data.ocr.result!.regions = words.map((text, i) => ({ kind: 'text', text, confidence: .2, bounds: { x: 120, y: 10 + i * 15, width: 60, height: 10 } }));
    const plan = normalize(data, new Placeholders());
    expect(words.filter((_, i) => covers(plan.masks, data.ocr.result!.regions[i].bounds))).toEqual(['mira@example.test']);
    expect(() => verifyMaskCoverage(data, plan.masks, plan.findings)).not.toThrow();
    data.ocrTextPolicy = 'all_text';
    const strict = normalize(data, new Placeholders());
    for (const region of data.ocr.result!.regions) expect(covers(strict.masks, region.bounds)).toBe(true);
  });
  it('describes controls by their own labels and withholds only classified PII', async () => {
    const data = form();
    const labels = ['About', 'Sign in', "I'm Feeling Lucky", 'हिन्दी', 'Contact mira@example.test'];
    data.observation.dom.elements = labels.map((label, i) => ({ id: `${binding.observationId}_e${i + 1}`, role: 'link', type: 'a', label,
      sensitive: false, disabled: false, filled: false, bounds: { x: 10, y: 10 + i * 25, width: 150, height: 20 } }));
    const result = await buildSafeStepRequest({ data, current: () => data.binding, signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.elements.map(element => element.description)).toEqual([...labels.slice(0, 4), 'Contact [EMAIL_1]']);
    expect(result.withheldReasons).not.toContain('TEXT_WITHHELD_POLICY');
    expect(sanitizeText("I'm Feeling Lucky", 'element_description').sanitized).toBe('[DOCUMENT_1] [DOCUMENT_2] [DOCUMENT_3]');
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
      .toEqual({ x: 0, y: 150, width: 200, height: 10 });
  });
});

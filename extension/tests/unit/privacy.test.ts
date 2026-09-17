import { describe, expect, it } from 'vitest';
import { StepRequestSchema } from '../../src/contracts';
import { classify, luhn } from '../../src/privacy/classify';
import { BoundsSchema, FindingSchema, LIMITS, MaskSchema } from '../../src/privacy/contracts';
import { buildSafeStepRequest } from '../../src/privacy';
import { domBounds, mergeMasks, paddedMask, tileMasks } from '../../src/privacy/geometry';
import { normalize, reconstructOcr } from '../../src/privacy/normalize';
import { finalCheck } from '../../src/privacy/payload';
import { containsLeak, Placeholders, sanitizeText } from '../../src/privacy/text';
import { LocalValueVault } from '../../src/privacy/value-vault';
import { binding, fictional, fixture } from '../privacy-fixture';

describe('local PII and text policy', () => {
  it.each([
    ['email', 'mira@example.test'], ['phone', '+91 98765 43210'], ['pan', 'ABCDE1234F'], ['aadhaar', '1234 5678 9012'],
    ['payment_card', '4111 1111 1111 1111'], ['ifsc', 'ABCD0123456'], ['password', 'password: fictional-secret-42'],
    ['otp', 'OTP: 123456'], ['token', 'Bearer fictional-session-value'], ['api_key', 'API key: fictional-key-value'],
    ['person_name', 'Contact Mira'], ['address', 'Address: 123 Fictional Lane'], ['date_of_birth', 'DOB: 1999-01-02'],
    ['passport', 'Passport: A1234567'], ['bank_account', 'Account number: 12345678901'],
  ])('replaces %s candidates without exposing the match', (kind, value) => {
    expect(classify(value).some(span => span.kind === kind)).toBe(true);
    const result = sanitizeText(value, 'instruction');
    expect(result.sanitized).not.toContain(value);
    expect(result.findings[0].text).toBeDefined();
    expect(result.findings[0].id).toMatch(/^finding_\d+$/);
  });
  it('validates Luhn without claiming invalid candidates are cards', () => {
    expect(luhn('4111 1111 1111 1111')).toBe(true);
    expect(luhn('4111 1111 1111 1112')).toBe(false);
    expect(luhn('0000000000000000')).toBe(false);
    expect(classify('4111 1111 1111 1112').some(s => s.kind === 'payment_card')).toBe(false);
    expect(sanitizeText('4111\n1111\n1111\n1111', 'instruction').sanitized).not.toContain('4111');
  });
  it('normalizes full-width and invisible characters and withholds unsupported text/overflow', () => {
    expect(sanitizeText('ｍｉｒａ＠ｅｘａｍｐｌｅ．ｔｅｓｔ', 'instruction').sanitized).toBe('[EMAIL_1]');
    expect(sanitizeText('mi\u200bra@example.test', 'instruction').sanitized).toBe('[EMAIL_1]');
    expect(() => sanitizeText('निजी विवरण', 'instruction')).toThrow('TEXT_WITHHELD');
    expect(() => sanitizeText('x'.repeat(LIMITS.text + 1), 'instruction')).toThrow('LIMIT_EXCEEDED');
  });
  it('allocates deterministic placeholders locally and clears the mapping', () => {
    const tokens = new Placeholders();
    expect(sanitizeText('mira@example.test mira@example.test', 'instruction', tokens).sanitized).toBe('[EMAIL_1] [EMAIL_1]');
    expect(sanitizeText('nora@example.test', 'instruction', tokens).sanitized).toBe('[EMAIL_2]');
    tokens.clear();
    expect(sanitizeText('nora@example.test', 'instruction', tokens).sanitized).toBe('[EMAIL_1]');
  });
  it('rescans placeholders safely but rejects normalized known-value leaks', () => {
    expect(containsLeak('[EMAIL_1]', fictional)).toBe(false);
    expect(containsLeak('ＭＩＲＡ@EXAMPLE.TEST', fictional)).toBe(true);
    expect(containsLeak('Name: Mira Fictional', ['Mira Fictional'])).toBe(true);
  });
  it('withholds unclassified names, prose and identifiers while retaining task grammar', () => {
    const result = sanitizeText('Fill Mira Fictional using my profile', 'instruction');
    expect(result.sanitized).toBe('Fill [DOCUMENT_1] [DOCUMENT_2] using my profile');
    expect(sanitizeText(result.sanitized, 'instruction').sanitized).toBe(result.sanitized);
  });
});

describe('strict local geometry and OCR contracts', () => {
  it.each([{ x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: NaN, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: Infinity, height: 1 }])('rejects malformed bounds %#', bounds => {
    expect(BoundsSchema.safeParse(bounds).success).toBe(false);
  });
  it('rejects extra finding/mask keys and out-of-page boxes', () => {
    expect(FindingSchema.safeParse({ raw: 'secret' }).success).toBe(false);
    expect(MaskSchema.safeParse({ bounds: { x: 0, y: 0, width: 1, height: 1 }, reasons: ['face'], raw: 'secret' }).success).toBe(false);
    expect(() => paddedMask({ x: 199, y: 1, width: 2, height: 2 }, 'face', 200, 200)).toThrow('INVALID_BOUNDS');
  });
  it.each([1, 1.25, 2])('converts scrolled and offset DOM coordinates at scale %s', scale => {
    const { observation } = fixture();
    observation.imageWidth *= scale; observation.imageHeight *= scale;
    Object.assign(observation.dom.viewport, { scrollX: 10, scrollY: 20, offsetX: 2, offsetY: 3, devicePixelRatio: scale });
    expect(domBounds({ x: 4, y: 5, width: 10, height: 20 }, observation)).toEqual({ x: 12 * scale, y: 22 * scale, width: 10 * scale, height: 20 * scale });
  });
  it('pads, clips, merges touching face/document/text masks transitively', () => {
    const masks = [paddedMask({ x: 1, y: 1, width: 10, height: 10 }, 'face', 200, 200),
      paddedMask({ x: 20, y: 20, width: 30, height: 30 }, 'document', 200, 200),
      paddedMask({ x: 50, y: 50, width: 20, height: 20 }, 'email', 200, 200)];
    const merged = mergeMasks(masks);
    expect(merged).toHaveLength(1); expect(merged[0].bounds).toEqual({ x: 0, y: 0, width: 74, height: 74 });
    expect(merged[0].reasons).toEqual(expect.arrayContaining(['face', 'document', 'email']));
    expect(paddedMask({ x: 1, y: 1, width: 2, height: 2 }, 'email', 200, 200, { text: 0, face: 0, document: 0 }).bounds).toEqual({ x: 1, y: 1, width: 2, height: 2 });
  });
  it('reconstructs a split email across lines and a tile seam into one combined mask', () => {
    const data = fixture(), result = normalize(data, new Placeholders());
    expect(reconstructOcr(data.ocr.result!.regions).spans).toHaveLength(3);
    const email = result.findings.find(f => f.source === 'ocr' && f.kind === 'email')!;
    expect(email.bounds).toEqual({ x: 10, y: 90, width: 80, height: 22 });
    for (const tile of data.observation.tiles) {
      const masks = tileMasks(result.masks, tile);
      expect(masks.some(mask => mask.bounds.y <= 100 - tile.y && mask.bounds.y + mask.bounds.height > 100 - tile.y)).toBe(true);
      expect(masks.every(mask => mask.bounds.y >= 0 && mask.bounds.y + mask.bounds.height <= tile.height)).toBe(true);
    }
  });
  it('never shrinks a supplied document to its overlapping OCR/face box', () => {
    const data = fixture(); data.documents.status = 'complete';
    data.documents.regions = [{ kind: 'document', confidence: .9, bounds: { x: 0, y: 60, width: 150, height: 130 } }];
    const result = normalize(data, new Placeholders());
    expect(result.masks.some(m => m.bounds.x === 0 && m.bounds.y <= 60 && m.bounds.width >= 150 && m.bounds.y + m.bounds.height >= 190)).toBe(true);
  });
});

describe('one fail-closed payload gateway', () => {
  const run = (data = fixture()) => buildSafeStepRequest({ data, signal: new AbortController().signal, current: () => binding });
  it('serializes only the exact v1 allowlist with no raw fixture values or screenshots', async () => {
    const result = await run(); if (!result.ok) throw new Error(result.blockedReasons.join(','));
    if (!result.ok) return;
    expect(StepRequestSchema.safeParse(result.request).success).toBe(true);
    const json = JSON.stringify(result.request);
    for (const value of [...fictional, 'Contact Mira', ...fixture().observation.tiles.map(t => t.screenshot.slice(22))]) expect(json).not.toContain(value);
    expect(Object.keys(result.request).sort()).toEqual(['protocolVersion', 'requestId', 'taskId', 'observationId', 'sanitizedInstruction', 'elements', 'valueRefs'].sort());
    expect(result.request.valueRefs).toEqual([]);
  });
  it('does not classify compacted public OCR prose as an authentication token', async () => {
    const data = fixture();
    data.instruction = 'Inspect this application form';
    data.ocr.result!.regions = [{ kind: 'text', text: data.instruction, confidence: .99, bounds: { x: 10, y: 50, width: 170, height: 20 } }];
    expect((await run(data)).ok).toBe(true);
  });
  it.each(['ocr', 'faces'] as const)('blocks incomplete, truncated, stale, and mock %s evidence', async kind => {
    for (const mode of ['status', 'truncated', 'stale', 'mock', 'tiles']) {
      const data = fixture();
      if (mode === 'status') data[kind].status = 'incomplete';
      if (mode === 'truncated') data[kind].truncated = true;
      if (mode === 'stale') data[kind].result!.observationId = 'old';
      if (mode === 'mock') data[kind].result!.source = 'mock';
      if (mode === 'tiles') data[kind].completedTiles = 1;
      expect((await run(data)).ok).toBe(false);
    }
  });
  it('blocks malformed bounds, missing tiles, unknown sources, missing required documents and truncation', async () => {
    const mutations = [
      (d: ReturnType<typeof fixture>) => { d.faces.result!.regions[0].bounds.width = 999; },
      (d: ReturnType<typeof fixture>) => { d.observation.tiles.pop(); },
      (d: ReturnType<typeof fixture>) => { d.ocr.result!.regions[0].kind = 'unknown'; },
      (d: ReturnType<typeof fixture>) => { d.documents.required = true; },
      (d: ReturnType<typeof fixture>) => { d.observation.dom.truncated = true; },
      (d: ReturnType<typeof fixture>) => { d.instruction = 'x'.repeat(2001); },
      (d: ReturnType<typeof fixture>) => { d.observation.captureBounds.width = 0; d.observation.dom.elements = []; },
      (d: ReturnType<typeof fixture>) => { d.observation.dom.viewport.devicePixelRatio = Infinity; },
    ];
    for (const mutate of mutations) { const data = fixture(); mutate(data); expect((await run(data)).ok).toBe(false); }
  });
  it('blocks stale task/origin/revision/generation/tab and Stop', async () => {
    for (const changed of [{ taskId: 'other' }, { origin: 'https://other.test' }, { revision: 1 }, { generation: 2 }, { tabId: 2 }]) {
      expect(await buildSafeStepRequest({ data: fixture(), signal: new AbortController().signal, current: () => ({ ...binding, ...changed }) })).toEqual({ ok: false, blockedReasons: ['STALE_OBSERVATION'] });
    }
    const controller = new AbortController(); controller.abort();
    expect(await buildSafeStepRequest({ data: fixture(), signal: controller.signal, current: () => binding })).toEqual({ ok: false, blockedReasons: ['STOPPED'] });
  });
  it('withholds optional failed images, blocks required images, and never substitutes original bytes', async () => {
    const data = fixture(); data.image = 'optional';
    const result = await run(data);
    expect(result.ok && result.decision).toBe('safe_without_image');
    if (result.ok) expect(result.request.sanitizedImage).toBeUndefined();
    data.image = 'required'; expect((await run(data)).ok).toBe(false);
  });
  it('rejects injected PII in every field, unknown keys and over-limit Base64', async () => {
    const result = await run(); if (!result.ok) throw new Error('Fixture failed');
    for (const value of fictional) expect(() => finalCheck({ ...result.request, sanitizedInstruction: value }, fictional, [])).toThrow('RAW_DATA_LEAK');
    expect(() => finalCheck({ ...result.request, taskId: 'ABCDE1234F' }, [], [])).toThrow('RAW_DATA_LEAK');
    expect(() => finalCheck({ ...result.request, elements: [{ ...result.request.elements[0], id: 'MiraFictional' }] }, [], [])).toThrow('RAW_DATA_LEAK');
    expect(() => finalCheck({ ...result.request, rawOcr: fictional[0] }, [], [])).toThrow('RAW_DATA_LEAK');
    expect(StepRequestSchema.safeParse({ ...result.request, sanitizedImage: { mimeType: 'image/png', base64: 'x'.repeat(4_000_001) } }).success).toBe(false);
  });
  it('fails at aggregate region and mask budgets without truncating data', async () => {
    const data = fixture();
    data.ocr.result!.regions = Array.from({ length: LIMITS.regions }, () => data.ocr.result!.regions[0]);
    expect((await run(data)).ok).toBe(false);
    expect(() => mergeMasks(Array.from({ length: LIMITS.masks + 1 }, () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, reasons: ['face'] })))).toThrow('LIMIT_EXCEEDED');
  });
});

describe('approved profile vault', () => {
  it('exports only approved opaque references and resolves only the bound destination', async () => {
    const data = fixture(), abort = new AbortController(), vault = new LocalValueVault(binding, abort.signal, () => binding);
    const id = vault.approve({ source: 'approved_profile', approved: true, kind: 'email', value: 'nora@example.test', target: data.observation.dom.elements[0].id }, data.observation.dom.elements[0]);
    try {
      expect(vault.resolve(id, binding, `${binding.observationId}_e1`)).toBe('nora@example.test');
      const result = await buildSafeStepRequest({ data, signal: abort.signal, current: () => binding, vault });
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain('nora@example.test');
      if (result.ok) expect(result.request.valueRefs).toEqual([{ id, purpose: 'Contact email', target: `${binding.observationId}_e1` }]);
      for (const change of [{ origin: 'https://other.test' }, { taskId: 'other' }, { observationId: 'other' }]) expect(() => vault.resolve(id, { ...binding, ...change }, `${binding.observationId}_e1`)).toThrow('INVALID_REFERENCE');
      expect(() => vault.resolve(id, binding, 'other')).toThrow('INVALID_REFERENCE');
      abort.abort(); expect(() => vault.resolve(id, binding, `${binding.observationId}_e1`)).toThrow('INVALID_REFERENCE');
    } finally { vault.clear(); }
  });
  it('rejects credentials, page provenance, unapproved data and sensitive targets', () => {
    const element = fixture().observation.dom.elements[0], vault = new LocalValueVault(binding, new AbortController().signal, () => binding);
    const approval = { source: 'approved_profile' as const, approved: true as const, kind: 'email' as const, value: 'nora@example.test', target: element.id };
    try {
      for (const raw of [{ ...approval, source: 'ocr' }, { ...approval, approved: false }, { ...approval, kind: 'password' },
        { ...approval, kind: 'person_name', value: 'password: fictional-secret-42' }, { ...approval, kind: 'person_name', value: '123456' }]) {
        expect(() => vault.approve(raw as typeof approval, element)).toThrow('INVALID_REFERENCE');
      }
      expect(() => vault.approve(approval, { ...element, sensitive: true })).toThrow('INVALID_REFERENCE');
      expect(() => vault.approve(approval, { ...element, role: 'button' })).toThrow('INVALID_REFERENCE');
    } finally { vault.clear(); }
  });
  it('clears on expiration and invalidation', () => {
    let now = 0, current = { ...binding };
    const vault = new LocalValueVault(binding, new AbortController().signal, () => current, () => now);
    now = LIMITS.ttlMs; expect(() => vault.references(binding)).toThrow('INVALID_REFERENCE');
    const next = new LocalValueVault(binding, new AbortController().signal, () => current);
    current = { ...binding, generation: 2 }; expect(() => next.references(binding)).toThrow('INVALID_REFERENCE');
  });
});

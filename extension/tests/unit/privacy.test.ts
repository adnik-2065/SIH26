import { describe, expect, it } from 'vitest';
import { StepRequestSchema } from '../../src/contracts';
import { openRedactionCandidates } from '../../src/privacy/openredaction';
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
    ['email', 'mira@example.test'], ['phone', '9876543210'], ['aadhaar', 'Aadhaar: 2345 6789 0124'],
    ['payment_card', '4111 1111 1111 1111'], ['ifsc', 'IFSC: ABCD0123456'], ['password', 'password: fictional-secret-42'],
    ['otp', 'OTP: 123456'], ['token', 'Bearer fictional-session-value'], ['api_key', 'API key: fictional-key-value'],
    ['person_name', 'Name: Mira Fictional'], ['address', 'Address: 123 Fictional Lane'], ['date_of_birth', 'DOB: 02/01/1999'],
    ['passport', 'Passport: A1234567'], ['bank_account', 'GB82 WEST 1234 5698 7654 32'],
  ])('replaces %s candidates without exposing the match', (kind, value) => {
    expect(openRedactionCandidates(value).some(span => span.kind === kind)).toBe(true);
    const result = sanitizeText(value, 'instruction');
    expect(result.sanitized).not.toContain(value);
    expect(result.findings[0].text).toBeDefined();
    expect(result.findings[0].id).toMatch(/^finding_\d+$/);
  });
  it('rejects an invalid payment-card candidate and still withholds it on the page', () => {
    // OpenRedaction's own validator (Luhn) rejects the checksum failure, so no
    // payment_card candidate is produced for the invalid number.
    expect(openRedactionCandidates('4111 1111 1111 1112').some(s => s.kind === 'payment_card')).toBe(false);
    // Text taken from the page is still withheld as unclassified rather than
    // carried out because a rule did not fire.
    const result = sanitizeText('Card: 4111 1111 1111 1112', 'element_description');
    expect(result.sanitized).not.toContain('4111');
    expect(openRedactionCandidates('4111 1111 1111 1111').some(s => s.kind === 'payment_card')).toBe(true);
  });
  it('normalizes full-width and invisible characters and withholds unsupported text/overflow', () => {
    expect(sanitizeText('ｍｉｒａ＠ｅｘａｍｐｌｅ．ｔｅｓｔ', 'instruction').sanitized).toBe('[EMAIL_1]');
    expect(sanitizeText('mi\u200bra@example.test', 'instruction').sanitized).toBe('[EMAIL_1]');
    expect(() => sanitizeText('x'.repeat(LIMITS.text + 1), 'instruction')).toThrow('LIMIT_EXCEEDED');
  });
  // Unicode is ordinary content on this project's own pages. It is processed by
  // the same allowlist as ASCII rather than rejected for not being ASCII, which
  // used to block an entire payload over a rupee sign.
  it.each([
    // Unknown words are withheld in every script; symbols and punctuation are
    // carried exactly as ASCII punctuation always was.
    ['a rupee amount', 'Fee ₹499', '[DOCUMENT_1] ₹[DOCUMENT_2]'],
    ['Devanagari', 'निजी विवरण', '[DOCUMENT_1] [DOCUMENT_2]'],
    ['accents', 'José Álvarez', '[DOCUMENT_1] [DOCUMENT_2]'],
    ['emoji beside allowlisted words', 'Submit ✅ now 🎉', 'Submit ✅ [DOCUMENT_1] 🎉'],
    ['typographic punctuation', 'Don’t — really…', '[DOCUMENT_1] — [DOCUMENT_2]...'],
  ])('carries %s through the page-text allowlist instead of refusing it', (_label, text, expected) => {
    expect(sanitizeText(text, 'element_description').sanitized).toBe(expected);
  });
  it('lets the user\u2019s own instruction keep its script', () => {
    expect(sanitizeText('प्रोफ़ाइल पेज खोलें', 'instruction').sanitized).toBe('प्रोफ़ाइल पेज खोलें');
    expect(sanitizeText('pay ₹499 now', 'instruction').sanitized).toBe('pay ₹499 now');
  });
  // A stray control byte or broken surrogate in one page label used to refuse
  // the whole export and stop the run. It is replaced one code unit for one,
  // so detection offsets still land on the same characters.
  it('repairs control characters and unpaired surrogates instead of refusing the text', () => {
    expect(sanitizeText('bad' + String.fromCharCode(7) + 'bell', 'instruction').sanitized).toBe('bad bell');
    expect(sanitizeText('bad' + String.fromCharCode(0xD800) + 'end', 'instruction').sanitized).toBe('bad\uFFFDend');
    const result = sanitizeText('x' + String.fromCharCode(7) + ' mira@example.test', 'instruction');
    expect(result.sanitized).toBe('x  [EMAIL_1]');
    expect(result.findings[0].textRange).toEqual({ start: 3, end: 20 });
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
  it('withholds unclassified names, prose and identifiers in text taken from the page', () => {
    // Page text cannot be cleared word by word without a NER model, so anything
    // the rules do not recognise is withheld.
    const result = sanitizeText('Fill Mira Fictional using my profile', 'element_description');
    expect(result.sanitized).toBe('Fill [DOCUMENT_1] [DOCUMENT_2] using my profile');
    expect(sanitizeText(result.sanitized, 'element_description').sanitized).toBe(result.sanitized);
  });
  it('keeps the user\'s own instruction readable and still redacts PII inside it', () => {
    // The instruction is typed into this panel, not read off the page. Replacing
    // every unrecognised word made it meaningless: "login into this lms portal"
    // became "[DOCUMENT_1] [DOCUMENT_2] this [DOCUMENT_3] portal".
    expect(sanitizeText('login into this lms portal', 'instruction').sanitized).toBe('login into this lms portal');
    expect(sanitizeText('Register for CS2201 in Block B', 'instruction').sanitized).toBe('Register for CS2201 in Block B');
    // Classification still runs, so recognisable identifiers never leave.
    const tokens = new Placeholders();
    expect(sanitizeText('email nora@example.test about my card 4111 1111 1111 1111', 'instruction', tokens).sanitized)
      .toBe('email [EMAIL_1] about my card [PAYMENT_CARD_1]');
    // An unrecognised personal name typed by the user is no longer withheld:
    // the panel warns about this directly under the instruction box.
    expect(sanitizeText('Fill Mira Fictional using my profile', 'instruction').sanitized)
      .toBe('Fill Mira Fictional using my profile');
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
    for (const value of [...fictional, ...fixture().observation.tiles.map(t => t.screenshot.slice(22))]) expect(json).not.toContain(value);
    expect(Object.keys(result.request).sort()).toEqual(['protocolVersion', 'requestId', 'taskId', 'observationId', 'sanitizedInstruction', 'elements', 'valueRefs'].sort());
    expect(result.request.valueRefs).toEqual([]);
  });
  it('sends an ordinary instruction whose words also appear on the page', async () => {
    // Two gates used to block this. The final check re-sanitized every field
    // with the page-text allowlist, which rewrote the instruction it had just
    // exempted and read the rewrite as a leak; and every page word the
    // allowlist could not clear was treated as a known secret, so an
    // instruction sharing vocabulary with the page ("lms") looked like one too.
    const data = fixture();
    data.instruction = 'login into this lms portal';
    data.observation.dom.elements[0].label = 'Sign in to the lms';
    const result = await run(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.sanitizedInstruction).toBe('login into this lms portal');
    // The page's own wording is still withheld; only the user's sentence is not.
    expect(result.request.elements[0].description).not.toContain('lms');
  });
  it('still redacts classified PII from the instruction and withholds page values', async () => {
    const data = fixture();
    data.instruction = 'email mira@example.test about the lms portal';
    const result = await run(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.sanitizedInstruction).toBe('email [EMAIL_1] about the lms portal');
    expect(JSON.stringify(result.request)).not.toContain('mira@example.test');
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
      expect(await buildSafeStepRequest({ data: fixture(), signal: new AbortController().signal, current: () => ({ ...binding, ...changed }) })).toMatchObject({ ok: false, blockedReasons: ['STALE_OBSERVATION'] });
    }
    const controller = new AbortController(); controller.abort();
    expect(await buildSafeStepRequest({ data: fixture(), signal: controller.signal, current: () => binding })).toMatchObject({ ok: false, blockedReasons: ['STOPPED'] });
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
  it('rewrites a detected page value repeated in the instruction instead of blocking the step', async () => {
    const data = fixture();
    data.instruction = 'message Asha Rao about the form';
    data.ocr.result!.regions = ['Name:', 'Asha', 'Rao'].map((text, i) => ({ kind: 'text', text, confidence: .99, bounds: { x: 10 + i * 40, y: 50, width: 35, height: 10 } }));
    const result = await run(data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.sanitizedInstruction).toBe('message [PERSON_1] about the form');
    expect(result.summary.rewritten).toBe(1);
    expect(result.withheldReasons).toContain('TEXT_WITHHELD_POLICY');
    expect(JSON.stringify(result.request)).not.toMatch(/asha|rao/i);
  });
  it('reads a long page in chunks instead of refusing it, and still finds values at the end', async () => {
    const data = fixture();
    const words = Array.from({ length: 2400 }, () => 'attendance');
    data.ocr.result!.regions = [...words, 'mira@example.test'].map(text => ({ kind: 'text', text, confidence: .99, bounds: { x: 10, y: 50, width: 30, height: 10 } }));
    const plan = normalize(data, new Placeholders());
    expect(plan.findings.some(finding => finding.kind === 'email' && finding.source === 'ocr')).toBe(true);
    const result = await run(data);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('mira@example.test');
  });
  it('fails at aggregate region and mask budgets without truncating data', async () => {
    const data = fixture();
    data.ocr.result!.regions = Array.from({ length: LIMITS.regions }, () => data.ocr.result!.regions[0]);
    expect((await run(data)).ok).toBe(false);
    expect(() => mergeMasks(Array.from({ length: LIMITS.masks + 1 }, () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, reasons: ['face'] })))).toThrow('LIMIT_EXCEEDED');
  });
});

describe('OpenRedaction adapter precision', () => {
  const kinds = (text: string) => openRedactionCandidates(text).map(span => [span.kind, text.slice(span.start, span.end)]);
  it.each([
    ['a passport label', 'Passport No'],
    ['a course name', 'Course name: Data Structures'],
    ['an all-caps heading', 'COMPUTER SCIENCE DEPARTMENT'],
    ['a title-case heading near a name label', 'Contact us for Student Services Portal'],
    ['password help text', 'Password is required'],
    ['OTP help text', 'OTP is invalid, try again'],
    ['a payment card, as Aadhaar', '4111 1111 1111 1111'],
    ['a grouped number with a bad checksum', '4918 3726 5010'],
    ['password help text', 'Password must be at least 8 characters'],
    ['an unlabeled heading', 'QUICK LINKS BELOW'],
    ['an ISBN', 'ISBN 978-3-16-148410-0'],
    ['an IP address', 'IP Address: 10.0.0.12'],
    ['a greeting to a group', 'Hello ALL USERS'],
    ['a lowercase phrase after a name label', 'Name: asha rao'],
  ])('does not flag %s', (_label, text) => {
    expect(kinds(text).filter(([kind]) => kind !== 'payment_card')).toEqual([]);
  });
  it.each([
    ['person_name', 'Welcome back, Asha Rao', 'Asha Rao'],
    ['person_name', 'Name: Asha Rao Profile', 'Asha Rao'],
    ['person_name', 'Logged in as Asha Rao', 'Asha Rao'],
    ['date_of_birth', 'Demo University portal. DOB: 02/01/1999', '02/01/1999'],
    ['pan', 'PAN ABCPE1234F', 'ABCPE1234F'],
    ['phone', 'Call +91 98765 43210 today', '+91 98765 43210'],
    ['phone', 'Mobile 98765-43210', '98765-43210'],
    ['aadhaar', '4918 3726 5017', '4918 3726 5017'],
    ['bank_account', 'Pay to asha.rao@okaxis now', 'asha.rao@okaxis'],
    ['bank_account', 'UPI ID: asha@mybank', 'asha@mybank'],
    ['bank_account', 'A/c No: 1234 5678 9012', '1234 5678 9012'],
    ['document', 'Voter ID ABC1234567', 'ABC1234567'],
    ['document', 'DL MH-12-2019-0012345', 'MH-12-2019-0012345'],
    ['document', 'GSTIN 27ABCPE1234F1Z5', '27ABCPE1234F1Z5'],
    ['passport', 'Passport: J8369854', 'J8369854'],
    ['otp', 'Your OTP 482913 expires soon', 'OTP 482913'],
    ['otp', '482913 is your OTP', '482913 is your OTP'],
    ['person_name', 'Name: ASHA RAO', 'ASHA RAO'],
    ['person_name', 'Name: R. K. Sharma', 'R. K. Sharma'],
    ['person_name', 'Student: Asha Rao', 'Asha Rao'],
    ['date_of_birth', 'DOB: 2002-08-15', '2002-08-15'],
    ['date_of_birth', 'DOB: 15.08.2002', '15.08.2002'],
    ['date_of_birth', 'Date of Birth: 15 Aug 2002', '15 Aug 2002'],
    ['date_of_birth', 'Birth Date: August 15, 2002', 'August 15, 2002'],
    ['date_of_birth', 'D.O.B. 15/08/2002', '15/08/2002'],
    ['address', 'Address: Flat 4B, Sunrise Apartments, Andheri West, Mumbai - 400053',
      'Flat 4B, Sunrise Apartments, Andheri West, Mumbai - 400053'],
    ['address', 'Address: 221B Baker Street Phone: 98765 43210', '221B Baker Street'],
    ['phone', 'Tel: +1 (415) 555-2671', '+1 (415) 555-2671'],
    ['phone', 'Tel: +44 20 7946 0958', '+44 20 7946 0958'],
    ['password', 'Password: hunter2x Remember me', 'Password: hunter2x'],
    ['otp', 'OTP: 482913 Resend in 30s', 'OTP: 482913'],
    ['token', 'Authorization: Bearer abc.def.ghi next', 'Authorization: Bearer abc.def.ghi'],
  ])('flags %s in %j', (kind, text, value) => {
    expect(kinds(text)).toContainEqual([kind, value]);
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

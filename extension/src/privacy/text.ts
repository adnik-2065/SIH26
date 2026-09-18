import { canonical, classify, credentialKinds, type Span } from './classify';
import { LIMITS, PrivacyError, type Finding, type PiiKind } from './contracts';

// One allocator per local task/session. Raw values are never used to derive IDs.
export class Placeholders {
  #values = new Map<string, string>();
  #counts = new Map<PiiKind, number>();
  token(kind: PiiKind, value: string) {
    const key = `${kind}:${value}`;
    const existing = this.#values.get(key);
    if (existing) return existing;
    if (this.#values.size >= LIMITS.findings) throw new PrivacyError('LIMIT_EXCEEDED');
    const count = (this.#counts.get(kind) ?? 0) + 1;
    this.#counts.set(kind, count);
    const token = `[${kind === 'person_name' ? 'PERSON' : kind.toUpperCase()}_${count}]`;
    this.#values.set(key, token); return token;
  }
  clear() { this.#values.clear(); this.#counts.clear(); }
}
// No NER model is installed. Export only this small task/control vocabulary
// outside positively classified spans. Unknown prose, names, identifiers and
// numbers are withheld, rather than treating a regex non-match as clearance.
const safeWords = new Set(('a an the my your this that these those i me we our and or at to from for with using use of in on by before after ' +
  'please inspect read review contact fill enter select choose click check uncheck scroll wait stop submit send complete application form ' +
  'approved local profile information details value values field fields control controls button link text name full first last applicant ' +
  'email phone telephone mobile number address postal date birth city state country zip code required optional disabled unavailable reference ' +
  'workshop web development computer vision register registration agree consent synthetic test demo portal layout change add reset toggle ' +
  'seconds second help next previous continue cancel save search find upload file confirm confirmation enabled editable not no yes is are be ' +
  'has have do does done below above page image images only visible all current view open close show hide settings sensitive unlabelled ' +
  'textbox combobox checkbox radio spinbutton slider listbox switch').split(' '));
const placeholderPattern = /\[(?:PERSON|EMAIL|PHONE|ADDRESS|DATE_OF_BIRTH|AADHAAR|PAN|PASSPORT|PAYMENT_CARD|BANK_ACCOUNT|IFSC|FACE|DOCUMENT|PASSWORD|OTP|TOKEN|API_KEY)_\d+\]/g;
export function sanitizeText(raw: string, context: 'instruction' | 'element_description' | 'ocr',
  placeholders = new Placeholders(), ocrPolicy: 'all_text' | 'sensitive_only' = 'all_text') {
  const normalized = canonical(raw);
  // English OCR is the only installed language. Withhold unsupported scripts
  // and control characters instead of pretending the rules classified them.
  if ((context !== 'ocr' || ocrPolicy === 'all_text') && /[^\x20-\x7E\n\r\t]/.test(normalized)) throw new PrivacyError('TEXT_WITHHELD');
  const matches = classify(normalized), spans: Span[] = [];
  // The allowlist below is the answer to untrusted page content: with no NER
  // model, a word the rules do not recognise cannot be cleared, so it is
  // withheld. The instruction is different in kind. The user typed it into this
  // panel to say what to do, so replacing every unrecognised word leaves the
  // server "[DOCUMENT_1] [DOCUMENT_2] this [DOCUMENT_3] portal" for "login into
  // this lms portal" — unusable, and no safer, since the sentence is the user's
  // own and never came off the page. Classified PII is still redacted from it.
  if (context !== 'instruction' && (context !== 'ocr' || ocrPolicy === 'all_text')) {
    const placeholders = [...normalized.matchAll(placeholderPattern)].map(match => ({ start: match.index!, end: match.index! + match[0].length }));
    for (const match of normalized.matchAll(/[A-Za-z0-9_'-]+/g)) {
      const start = match.index!, end = start + match[0].length;
      if (!safeWords.has(match[0].toLowerCase()) && !placeholders.some(span => start >= span.start && end <= span.end) &&
        !matches.some(span => start < span.end && end > span.start)) matches.push({ start, end, kind: 'document', unclassified: true });
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
  }
  for (const span of matches) {
    const last = spans.at(-1);
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      // A merged span is only unclassified if every part of it was.
      if (!span.unclassified) last.unclassified = false;
      if (credentialKinds.has(span.kind)) last.kind = span.kind;
      if ((span.confidence ?? 1) > (last.confidence ?? 1)) { last.detector = span.detector; last.confidence = span.confidence; }
    } else spans.push({ ...span });
  }
  let cursor = 0, sanitized = '';
  const findings: Finding[] = [];
  for (const [index, span] of spans.entries()) {
    const text = normalized.slice(span.start, span.end);
    sanitized += normalized.slice(cursor, span.start) + placeholders.token(span.kind, text);
    findings.push({ id: `finding_${index}`, source: context === 'element_description' ? 'dom' : context === 'ocr' ? 'ocr' : 'instruction',
      kind: span.kind, confidence: span.confidence ?? 1, detector: span.detector ?? 'existing_text_detector',
      textRange: { start: span.start, end: span.end }, text, exportPolicy: credentialKinds.has(span.kind) ? 'withhold' : 'replace',
      redactText: true, redactPixels: context !== 'instruction', ...(span.unclassified ? { unclassified: true } : {}) });
    cursor = span.end;
  }
  sanitized += normalized.slice(cursor);
  return { sanitized, findings, spans, normalized };
}

export const opaqueIdentifier = (value: string) => /^(?:(?:request|value)_)?[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?:_e\d+)?$/.test(value);
export function containsLeak(value: string, knownValues: readonly string[], identifier = false) {
  const normalized = canonical(value);
  // Remove only engine placeholder syntax before candidate classification.
  const unmarked = normalized.replace(placeholderPattern, '');
  const opaqueId = identifier && opaqueIdentifier(unmarked);
  if (!opaqueId && classify(unmarked).length) return true;
  const compact = unmarked.toLocaleLowerCase('en').replace(/\s+/g, '');
  return knownValues.some(raw => {
    const value = canonical(raw).toLocaleLowerCase('en').replace(/\s+/g, '');
    return value.length > 2 ? compact.includes(value) : !opaqueId && unmarked.toLowerCase().split(/\W+/).includes(value);
  });
}

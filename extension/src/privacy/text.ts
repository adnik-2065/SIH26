import { canonical, credentialKinds, openRedactionCandidates, type Span } from './openredaction';
import { LIMITS, privacyError, PrivacyError, type Finding, type PiiKind, type PrivacyStage } from './contracts';

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
  // Replaces each known value wherever it still occurs outside an existing
  // placeholder, with that value's own token. Matching mirrors containsLeak:
  // case-insensitive, whitespace inside the value ignored, and values of two
  // characters or fewer only as whole words.
  scrub(text: string, values: ReadonlyArray<{ kind: PiiKind; text: string }>) {
    const rules = values.flatMap(({ kind, text: raw }) => {
      const value = canonical(raw).replace(/\s+/g, '');
      return value ? [{ kind, raw, value }] : [];
    }).sort((a, b) => b.value.length - a.value.length);
    if (!rules.length) return text;
    const escape = (char: string) => char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const sources = rules.map(({ value }) => {
      const body = [...value].map(escape).join('\\s*');
      return value.length > 2 ? body : `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`;
    });
    const expression = new RegExp(sources.map(source => `(${source})`).join('|'), 'giu');
    const reserved = placeholderSpans(text);
    return text.replace(expression, (match, ...groups) => {
      const offset = groups[rules.length] as number;
      if (inside(reserved, offset, offset + match.length)) return match;
      const rule = rules[groups.findIndex((group, index) => index < rules.length && group !== undefined)];
      return this.token(rule.kind, rule.raw);
    });
  }
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
  'course courses curriculum grade grades preference preferences message messages dashboard announcement announcements inbox assignment assignments attendance ' +
  'textbox combobox checkbox radio spinbutton slider listbox switch option').split(' '));
const placeholderPattern = /\[(?:PERSON|EMAIL|PHONE|ADDRESS|DATE_OF_BIRTH|AADHAAR|PAN|PASSPORT|PAYMENT_CARD|BANK_ACCOUNT|IFSC|FACE|DOCUMENT|PASSWORD|OTP|TOKEN|API_KEY)_\d+\]/g;
// What actually makes a string unsafe to carry, as opposed to merely not being
// ASCII. Unicode is the normal case on this project's own pages: rupee amounts,
// typographic punctuation, accented names, Devanagari, emoji. Rejecting all of
// it blocked whole payloads for a currency symbol, which is neither a privacy
// control nor a correct one — the allowlist below is what withholds unknown
// words, and it now tokenizes every script rather than Latin only.
//
// These, by contrast, can hide or reorder what a reviewer reads, or mean the
// string never survived decoding intact. They used to refuse the whole export;
// one stray control byte in a page label then stopped the run. They are now
// replaced one code unit for one code unit, so every detection offset into the
// text still lands on the same characters.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const unsafeControl = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const nonCharacter = /[\uFDD0-\uFDEF\uFFFE\uFFFF]/gu;
// Letters, marks, digits and word-joining punctuation in any script. Anything a
// script writes as a word is a word here, so an unknown Devanagari or accented
// word is withheld exactly like an unknown Latin one.
const wordPattern = /[\p{L}\p{M}\p{N}_'\u2019\u02BC-]+/gu;
const repairUnsafe = (text: string) =>
  text.replace(loneSurrogate, '\uFFFD').replace(nonCharacter, '\uFFFD').replace(unsafeControl, ' ');
// Detection runs with every engine placeholder blanked to a same-length run of
// a non-word character. Removing them glued the text on either side together
// ('Name: [PERSON_1] Course Portal' read as 'Name:  Course Portal', a labeled
// name), and leaving them let a greedy rule swallow an existing placeholder.
const placeholderFill = (text: string) => text.replace(placeholderPattern, match => '\u2022'.repeat(match.length));
const placeholderSpans = (text: string) => [...text.matchAll(placeholderPattern)].map(match => ({ start: match.index!, end: match.index! + match[0].length }));
const inside = (spans: ReadonlyArray<{ start: number; end: number }>, start: number, end: number) => spans.some(span => start < span.end && end > span.start);
// Candidates outside existing placeholders. A placeholder is already redacted;
// a rule that matched across one is describing the engine's own output.
function candidates(text: string) {
  const reserved = placeholderSpans(text);
  return openRedactionCandidates(placeholderFill(text)).filter(span => !inside(reserved, span.start, span.end));
}
export function sanitizeText(raw: string, context: 'instruction' | 'element_description' | 'ocr',
  placeholders = new Placeholders(), policy: 'all_text' | 'sensitive_only' = 'all_text') {
  const stage: PrivacyStage = context === 'ocr' ? 'OCR' : 'PRIVACY_NORMALIZATION';
  let normalized: string;
  try {
    normalized = canonical(raw);
  } catch (error) {
    if (error instanceof PrivacyError) throw error;
    throw privacyError('TEXT_WITHHELD_SANITIZATION_FAILED', stage, 'The text could not be normalized.',
      { textLength: raw.length, errorName: error instanceof Error ? error.name : typeof error }, 'canonical() threw');
  }
  normalized = repairUnsafe(normalized);
  const matches = candidates(normalized), spans: Span[] = [];
  // The allowlist below is the answer to untrusted page content: with no NER
  // model, a word the rules do not recognise cannot be cleared, so it is
  // withheld. The instruction is different in kind. The user typed it into this
  // panel to say what to do, so replacing every unrecognised word leaves the
  // server "[DOCUMENT_1] [DOCUMENT_2] this [DOCUMENT_3] portal" for "login into
  // this lms portal" — unusable, and no safer, since the sentence is the user's
  // own and never came off the page. Classified PII is still redacted from it.
  // Context mode ('sensitive_only') withholds only classified PII, for control
  // labels as for OCR text. The allowlist there turned 'About', 'Sign in' and
  // 'I'm Feeling Lucky' into [DOCUMENT_n] while the same words stayed legible
  // in the unmasked screenshot, which hid nothing and left the server unable
  // to tell one control from another. Strict mode keeps the allowlist.
  if (context !== 'instruction' && policy === 'all_text') {
    const placeholders = [...normalized.matchAll(placeholderPattern)].map(match => ({ start: match.index!, end: match.index! + match[0].length }));
    for (const match of normalized.matchAll(wordPattern)) {
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
      kind: span.kind, confidence: span.confidence ?? 1, detector: span.detector ?? 'openredaction',
      textRange: { start: span.start, end: span.end }, text, exportPolicy: credentialKinds.has(span.kind) ? 'withhold' : 'replace',
      redactText: true, // An unclassified span is a word the rules could not clear, never positive
// evidence of PII. It stays withheld from the export (placeholder text,
// redactText), but painting its region black blanked ordinary UI - course
// titles, navigation, footer links - which is the localized over-masking
// defect proven at runtime. Positively classified spans still redact pixels
// in both policies.
redactPixels: context !== 'instruction' && !span.unclassified, ...(span.unclassified ? { unclassified: true } : {}) });
    cursor = span.end;
  }
  sanitized += normalized.slice(cursor);
  return { sanitized, findings, spans, normalized };
}

export const opaqueIdentifier = (value: string) => /^(?:(?:request|value)_)?[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?:_e\d+)?$/.test(value);
export function containsLeak(value: string, knownValues: readonly string[], identifier = false) {
  const normalized = canonical(value);
  // Engine placeholders are blanked, not removed, so text on either side of one
  // is never read as a single run.
  const unmarked = placeholderFill(normalized);
  const opaqueId = identifier && opaqueIdentifier(unmarked);
  if (!opaqueId && candidates(normalized).length) return true;
  const compact = unmarked.toLocaleLowerCase('en').replace(/\s+/g, '');
  return knownValues.some(raw => {
    const value = canonical(raw).toLocaleLowerCase('en').replace(/\s+/g, '');
    return value.length > 2 ? compact.includes(value) : !!value && !opaqueId && unmarked.toLowerCase().split(/[^\p{L}\p{N}_]+/u).includes(value);
  });
}

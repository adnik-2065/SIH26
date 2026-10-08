import { patterns } from '../../vendor/openredaction/patterns.js';
import { LIMITS, privacyError, PrivacyError, type PiiKind } from './contracts';

// OpenRedaction is the source of truth for text PII detection. This adapter
// iterates the generated vendor pattern set pattern by pattern, executes each
// pattern's validator against bounded context, and resolves overlaps
// deterministically. The full runtime detect()/restore() pair is deliberately
// not bundled: those allocate restoration maps and placeholder state the local
// pipeline must not keep.

// One span shape for every text-detection source. `detector` and `confidence`
// are optional because the synthetic unclassified spans created by text.ts
// carry neither, while OpenRedaction spans carry both. `kind` stays required,
// and `unclassified` marks withheld-without-clearance spans.
export interface Span {
  start: number;
  end: number;
  kind: PiiKind;
  detector?: 'openredaction';
  confidence?: number;
  // True when nothing classified this span and it is withheld only because the
  // allowlist could not clear it. Such a span is an absence of clearance, not a
  // detected value, and must not be treated as a known secret.
  unclassified?: boolean;
}

// Credential kinds gate export policy everywhere: vault approval, literal
// model text and leak scans refuse these even when no value shape matched.
export const credentialKinds = new Set<PiiKind>(['password', 'otp', 'token', 'api_key']);

// NFKC normalization plus removal of zero-width and bidi control characters,
// per the existing privacy design. Detection runs on the canonical form, so
// every offset below is a canonical-form offset.
export function canonical(raw: string) {
  if (raw.length > LIMITS.text) throw new PrivacyError('LIMIT_EXCEEDED');
  return raw.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
}

// Catalog type -> local PiiKind. Specific groups are listed first; the first
// group containing a type owns it. Types the pinned catalog does not ship
// (PAN, INDIAN_PASSPORT, AUTH_TOKEN, ...) stay as mapping entries so a future
// catalog release wires up without code changes; no custom regex is added to
// reproduce the deleted classifier.
const kindGroups: ReadonlyArray<readonly [PiiKind, readonly string[]]> = [
  ['person_name', ['NAME']],
  ['email', ['EMAIL']],
  ['phone', ['PHONE_INTERNATIONAL', 'PHONE_US', 'PHONE_UK', 'PHONE_UK_MOBILE', 'PHONE_LINE_NUMBER']],
  ['aadhaar', ['INDIAN_AADHAAR', 'AADHAAR']],
  ['pan', ['PAN', 'INDIAN_PAN']],
  ['ifsc', ['IFSC', 'INDIAN_IFSC']],
  ['passport', ['PASSPORT_UK', 'PASSPORT_US', 'PASSPORT_MRZ_TD3', 'PASSPORT_MRZ_TD1', 'INDIAN_PASSPORT', 'TURKMENISTAN_PASSPORT']],
  ['payment_card', ['PAYMENT_CARD', 'CREDIT_CARD', 'CARD_NUMBER', 'CVV', 'CARD_EXPIRY']],
  ['bank_account', ['IBAN', 'BANK_ACCOUNT', 'BANK_ACCOUNT_UK', 'ROUTING_NUMBER_US', 'ROUTING_NUMBER_MFG']],
  ['document', ['DOCUMENT', 'SSN', 'ENROLLMENT_NUMBER', 'UNIVERSITY_ID', 'STUDENT_ID']],
  ['api_key', ['GOOGLE_API_KEY', 'OPENAI_API_KEY', 'GENERIC_API_KEY', 'FIREBASE_API_KEY', 'HEROKU_API_KEY',
    'MAILGUN_API_KEY', 'SENDGRID_API_KEY', 'STRIPE_API_KEY', 'TWILIO_API_KEY']],
  ['token', ['MAC_ADDRESS', 'SLACK_TOKEN', 'DATABASE_CONNECTION', 'JWT_TOKEN', 'BEARER_TOKEN', 'AWS_ACCESS_KEY',
    'GITHUB_TOKEN', 'PRIVATE_KEY', 'URL_WITH_AUTH', 'DOCKER_AUTH', 'KUBERNETES_SECRET', 'NPM_TOKEN', 'PYPI_TOKEN',
    'OAUTH_TOKEN', 'OAUTH_CLIENT_SECRET', 'GCP_SERVICE_ACCOUNT', 'AUTH_TOKEN', 'ACCESS_TOKEN']],
  ['address', ['ADDRESS', 'ADDRESS_STREET']],
  ['date_of_birth', ['DATE_OF_BIRTH']],
  ['password', ['GENERIC_SECRET']],
];
const kinds: Record<string, PiiKind> = {};
for (const [kind, types] of kindGroups) for (const type of types) if (!(type in kinds)) kinds[type] = kind;
// Exposed so tests (and future callers) can verify the required catalog type
// mappings without executing any detection.
export const catalogTypeKinds = kinds;

// Shape-only catalog patterns whose own validator requires surrounding
// wording. The keyword sets mirror each validator's own context rule; without
// them a bare token that happens to match the shape would be masked.
const narrowContext: Partial<Record<string, RegExp>> = {
  IFSC: /ifsc|bank|branch|india|financial|payment|transfer/i,
  TURKMENISTAN_PASSPORT: /passport|pasport|travel|document/i,
  DATE_OF_BIRTH: /dob|date\s+of\s+birth|birth/i,
  STUDENT_ID: /student|pupil|scholar|roll|enrol|registr/i,
  ENROLLMENT_NUMBER: /enrol|registr|student|roll/i,
  UNIVERSITY_ID: /university|college|campus|student|enrol|registr/i,
};

// NAME needs deterministic acceptance beyond OpenRedaction's own validator:
// the catalog validator passes ordinary title-case wording such as 'My
// courses'. A NAME span is accepted only when (a) the surrounding text labels
// the value as a name, or (b) the value is three or more consecutive all-caps
// words. 'MOHAMMED ARSHAD KHAN' is accepted by (b); 'to Artificial
// Intelligence', 'My courses' and 'CBE311 Database Security' by neither.
const nameLabel = /\b(?:name|applicant|candidate|contact|dear|attn|signed)\b\s*:?\s+/i;
const nameCapitalized = /^[\p{Lu}][\p{Ll}'\u2019-]+(?:\s+[\p{Lu}][\p{Ll}'\u2019-]+)+$/u;
const nameAllCaps = /^(?:[A-Z]{3,}\s+){2,}[A-Z]{3,}$/;

// Credential labels. The pipeline requires password/otp/token/api_key
// detection (credentialKinds), but the pinned catalog has no OTP pattern and
// its GENERIC_SECRET validator rejects values that repeat the label word.
// These four label markers supply that evidence by context (a labeled value
// follows) rather than by value shape, and are the only non-catalog patterns
// in this module. Everything else stays OpenRedaction's.
const credentialLabels: ReadonlyArray<readonly [PiiKind, RegExp]> = [
  ['password', /\b(?:password|passwd|pwd)\b\s*(?:is\s*|[:=])\s*[^\n;,]{3,}/gi],
  ['otp', /\b(?:otp|one[ -]time\s*(?:password|code)|verification\s+code)\b\s*(?:is\s*|[:=])\s*[^\n;,]{3,}/gi],
  ['api_key', /\b(?:api[ _-]?key|secret[ _-]?key|client[ _-]?secret)\b\s*(?:is\s*|[:=])\s*[^\n;,]{3,}/gi],
  ['token', /\b(?:authorization|bearer|access[ _-]?token|auth[ _-]?token|session[ _-]?(?:id|token))\b\s*(?:is\s*|[:=])\s*[^\n;,]{3,}/gi],
];

interface Candidate { start: number; end: number; kind: PiiKind; confidence: number }

function acceptName(value: string, context: string) {
  if (nameAllCaps.test(value)) return true;
  return nameCapitalized.test(value) && nameLabel.test(context);
}

// Text PII candidates for DOM labels, OCR reconstructions and model values.
// Throws PrivacyError on limit or detection failure; offsets are canonical.
export function openRedactionCandidates(raw: string): Span[] {
  // canonical() enforces the text limit and normalizes NFKC/zero-width forms.
  const text = canonical(raw);
  const candidates: Candidate[] = [];
  try {
    const push = (candidate: Candidate) => {
      candidates.push(candidate);
      if (candidates.length > LIMITS.findings) throw new PrivacyError('LIMIT_EXCEEDED');
    };
    for (const pattern of patterns) {
      const kind = kinds[pattern.type];
      if (!kind) continue;
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      for (const match of text.matchAll(regex)) {
        // Bounded validator context. IBAN checksum validation is deliberately
        // context-independent: prose such as 'test IBAN' must not disable
        // protection of a valid account number.
        const matchStart = match.index!, matchEnd = matchStart + match[0].length;
        const context = pattern.type === 'IBAN' ? '' : text.slice(Math.max(0, matchStart - 50), Math.min(text.length, matchEnd + 50));
        // Some catalog patterns split the value across capture groups (IFSC's
        // bank code and branch suffix); their validators expect the full code.
        // Try the captured group first, then the whole match, so a candidate is
        // dropped only when both readings fail the pattern's own validator.
        const group = match[1] ?? match[0];
        const passes = (candidate: string) => !pattern.validator || pattern.validator(candidate, context);
        const value = passes(group) ? group : match[0] !== group && passes(match[0]) ? match[0] : '';
        if (!value) continue;
        const at = match[0].indexOf(value);
        const start = matchStart + (at >= 0 ? at : 0);
        const end = start + value.length;
        if (pattern.type === 'NAME' && !acceptName(value, context)) continue;
        const narrow = narrowContext[pattern.type];
        if (narrow && !narrow.test(context)) continue;
        push({ start, end, kind, confidence: pattern.validator ? .99 : .9 });
      }
    }
    for (const [kind, expression] of credentialLabels)
      for (const match of text.matchAll(new RegExp(expression.source, expression.flags)))
        push({ start: match.index!, end: match.index! + match[0].length, kind, confidence: 1 });
  } catch (error) {
    throw error instanceof PrivacyError ? error : privacyError('INCOMPLETE_DETECTION_OCR', 'PRIVACY_NORMALIZATION',
      'The OpenRedaction text detector failed, so its coverage of the page is unknown.',
      { errorName: error instanceof Error ? error.name : typeof error }, 'openredaction threw');
  }
  // Deterministic overlap resolution: earlier start wins, then the longer
  // span, then the kind name. A candidate overlapping one already kept is
  // discarded, so no region is ever reported twice and the wider, earlier
  // evidence (a labeled credential line) survives over fragments inside it.
  candidates.sort((a, b) => a.start - b.start || b.end - a.end || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const spans: Span[] = [];
  for (const candidate of candidates) {
    const last = spans.at(-1);
    if (last && candidate.start < last.end) continue;
    spans.push({ ...candidate, detector: 'openredaction' });
  }
  return spans;
}
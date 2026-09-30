import { analyzeFullContext, commonFalsePositives, isFalsePositive, patterns } from '../../vendor/openredaction/patterns.js';
import { LIMITS, privacyError, PrivacyError, type PiiKind } from './contracts';

// OpenRedaction is the source of truth for text PII detection. This adapter
// iterates the generated vendor pattern set pattern by pattern and runs each
// match through the engine's own stages: the pattern's validator against
// bounded context, the false-positive filter, and context confidence scoring
// against the engine's default thresholds. Overlaps are resolved
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
// (INDIAN_PASSPORT, AUTH_TOKEN, ...) stay as mapping entries so a future
// catalog release wires up without code changes. The Indian identifiers the
// catalog lacks entirely are supplied by `localPatterns` below.
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

// The engine's defaults: a false-positive rule at this certainty or more
// discards a match, and a match must score at least this in context.
const FALSE_POSITIVE_THRESHOLD = .7, CONFIDENCE_THRESHOLD = .5;
// The engine's false-positive rules that judge the value itself. The others
// fire on a common word or symbol anywhere in the \u00b150 character window,
// which is one sentence in a document but several unrelated links and fields
// on a captured page. They discarded real values: 'Call me on +44 20 7946
// 0958' ('on' reads as a date), a phone near 'Address' (an IP address), any
// email near 'https://' or holding 'test' or 'demo' (a code placeholder), and
// 'akbar@gmail.com' ('bar@' reads as test data).
const valueRules = new Set(['Year mistaken for PII', 'Port number mistaken for PII', 'Common word after article, not a name',
  'Common English word mistaken for social username', 'Example email domain', 'Test account/card number']);
const falsePositiveRules = commonFalsePositives.filter(rule => valueRules.has(rule.description));
if (falsePositiveRules.length !== valueRules.size) throw new Error('OpenRedaction false-positive rules changed');

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
// courses'. A NAME span is accepted only when (a) a name label or greeting
// immediately precedes the value, or (b) the value is three or more
// consecutive all-caps words. Either way the value must not contain ordinary
// heading vocabulary. 'MOHAMMED ARSHAD KHAN' is accepted by (b); 'Welcome
// back, Asha Rao' by (a); 'COMPUTER SCIENCE DEPARTMENT', 'Course name: Data
// Structures', 'My courses' and 'CBE311 Database Security' by neither.
// The label must end right where the value begins. Testing it anywhere in the
// \u00b150 character window accepted any title-case phrase that merely sat near
// the word 'name' or 'contact', which is how headings became PERSON tokens.
const nameLabel = /(?:\b(?:(?:full|first|last|middle|given|family|sur|applicant(?:'s)?|candidate(?:'s)?|student(?:'s)?|father(?:'s)?|mother(?:'s)?|guardian(?:'s)?|parent(?:'s)?|spouse(?:'s)?|nominee(?:'s)?|holder(?:'s)?|your|my)\s*)?name|\bapplicant|\bcandidate|\bcontact\s+person|\bstudent\s*:|\bdear|\battn|\bsigned\s+by|\bsigned|\bhello|\bhi|\bhey|\bwelcome(?:\s+back)?|\b(?:logged|signed)\s+in\s+as|\bmr|\bmrs|\bms|\bdr|\bshri|\bsmt|\bkumari)\s*[.:,-]?\s*$/i;
// A label naming a thing rather than a person ('Course name:', 'Bank name:').
const thingLabel = /\b(?:course|subject|company|college|institute|institution|school|university|department|project|product|event|program(?:me)?|batch|branch|bank|file|display|user|host|domain|app|application|group|team|class|module|paper|exam|book|brand|model|device|network|organi[sz]ation|business|shop|store|city|state|country|district|village|scheme|plan|board)\s*name\s*[.:,-]?\s*$/i;
// A labeled name: two to four words, each title-case ('Asha'), capitals
// ('ASHA', as forms and ID cards print it) or initials ('R.', 'R.K.'); the last
// is a full word. Unlabeled text still needs three all-caps words (below).
const nameWord = String.raw`(?:[\p{Lu}][\p{Ll}'\u2019-]+|[\p{Lu}]{2,}(?:['\u2019-][\p{Lu}]+)*)`;
const nameToken = String.raw`(?:${nameWord}|(?:[\p{Lu}]\.){1,3})`;
const nameLabeled = new RegExp(String.raw`^(?:${nameToken}\s*){1,3}(?<=[\s.])${nameWord}$`, 'u');
const nameAllCaps = /^(?:[A-Z]{3,}\s+){2,}[A-Z]{3,}$/;
// Words that occur in headings, navigation and organisation names but not in a
// person's name. One of them anywhere in the value rejects it.
const notNameWords = new Set(('about account accounts admin administration admission admissions application apply assignment attendance ' +
  'bank board campus center centre certificate class college committee company contact course courses dashboard department details ' +
  'development engineering event events exam examination faculty fee fees form government help home hostel india indian information ' +
  'institute institution international library limited login logout management menu national news notice office online page portal ' +
  'private profile program programme public registration report result results school science section semester service services settings ' +
  'student students study subject submit support system systems technology university welcome year the and of for to in on at with ' +
  'ltd pvt inc llc corp quick link links below above click here view more all new latest top main important download downloads ' +
  'resources gallery us our now today read see back next previous sign log register terms conditions privacy policy faq faqs ' +
  'careers alumni research placement placements tender tenders announcement announcements circular circulars sitemap feedback ' +
  'search share follow social media team everyone there guest user users sir madam members member staff friends ' +
  // Field labels that follow a name on the same line ('ASHA RAO DOB ...').
  'name dob age gender sex male female phone mobile email tel roll reg id no address pin aadhaar pan hello hey dear ' +
  'data lab laboratory manual syllabus lecture notes').split(' '));
const hasNotNameWord = (value: string) => value.toLowerCase().split(/[^\p{L}]+/u).some(word => notNameWords.has(word));

// Several catalog validators discard a match when the surrounding text
// contains words such as 'test', 'demo', 'sample' or 'example' \u2014 as plain
// substrings, so 'latest', 'contest' and 'Demo University' count too. That is
// right for documentation, and wrong here: a portal titled 'Demo' still shows
// a real person's date of birth. The words are blanked (same length) from the
// validator context only; the value itself is still checked as-is. EMAIL is
// exempt because its validator uses those words to *accept* a match.
const decoyWords = /example|test|sample|demo|fake|placeholder|dummy|mock/gi;
const companyWords = /\b(?:company|corporation|inc|llc|ltd|corp|organization|business|enterprise|firm|agency)\b/gi;
const blank = (match: string) => ' '.repeat(match.length);
function validatorContext(type: string, context: string) {
  if (type === 'EMAIL' || !context) return context;
  const stripped = context.replace(decoyWords, blank);
  // Name acceptance is decided by the label rule above, so an employer line
  // ('Pvt Ltd') next to a labeled name must not veto it.
  return type === 'NAME' ? stripped.replace(companyWords, blank) : stripped;
}
// Value checks the catalog validator omits. PASSPORT_US accepts any six to
// nine letters after 'pass', so 'Passport No' became 'Pass[PASSPORT_1]'.
const valueGuards: Partial<Record<string, (value: string) => boolean>> = {
  PASSPORT_US: value => /\d/.test(value),
  PASSPORT_UK: value => /\d/.test(value),
};

// Verhoeff checksum, which every issued Aadhaar number carries.
const verhoeffD = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]];
const verhoeffP = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]];
export function verhoeff(digits: string) {
  let check = 0;
  [...digits].reverse().forEach((digit, i) => { check = verhoeffD[check][verhoeffP[i % 8][Number(digit)]]; });
  return check === 0;
}

// Indian identifiers the pinned catalog does not ship. Each is either a
// distinctive shape (PAN, GSTIN, driving licence, UPI handle), carries its own
// checksum (grouped Aadhaar), or requires its label in the surrounding text
// (voter ID, Indian passport, account number). The value is capture group 1.
interface LocalPattern { type: string; kind: PiiKind; regex: RegExp; context?: RegExp; validator?: (value: string) => boolean }
const upiHandles = 'ok(?:axis|hdfcbank|icici|sbi)|ybl|ibl|axl|paytm|upi|apl|yapl|pt(?:yes|axis|hdfc|sbi)|axisbank|hdfcbank|icici|sbi|kotak|' +
  'federal|indus|rbl|idfcbank|jupiteraxis|fbl|wa(?:axis|hdfcbank|icici|sbi)|freecharge|airtel|jio|postbank|barodampay|unionbank|pnb|boi|' +
  'cnrb|allbank|aubank|citi|dbs|hsbc|kbl|kvb|mahb|sib|uco|yesbank|abfspay|ikwik|timecosmos|slice|axisb|naviaxis|superyes|tapicici|pingpay';
const month = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const localPatterns: readonly LocalPattern[] = [
  { type: 'INDIAN_PAN_LOCAL', kind: 'pan', regex: /\b([A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z])\b/g },
  { type: 'INDIAN_MOBILE_LOCAL', kind: 'phone', regex: /(?<![\d+])((?:(?:\+|00)91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5})(?![\d])/g },
  // 4-4-4 grouping with a valid checksum needs no label; an ungrouped
  // twelve-digit run could be anything, and stays with the catalog's
  // context-gated INDIAN_AADHAAR.
  { type: 'INDIAN_AADHAAR_LOCAL', kind: 'aadhaar', regex: /(?<!\d[\s-]?)([2-9]\d{3}[\s-]\d{4}[\s-]\d{4})(?![\s-]?\d)/g,
    validator: value => verhoeff(value.replace(/\D/g, '')) },
  { type: 'UPI_LOCAL', kind: 'bank_account', regex: new RegExp(`(?<![\\w.@-])([\\w.-]{2,256}@(?:${upiHandles}))(?![\\w.@-])`, 'gi') },
  { type: 'UPI_LABELED_LOCAL', kind: 'bank_account', regex: /\b(?:upi|vpa)(?:\s*id)?\s*[:=-]?\s*([\w.-]{2,256}@[a-z]{2,64})(?![\w.@-])/gi },
  { type: 'VOTER_ID_LOCAL', kind: 'document', regex: /\b([A-Z]{3}\d{7})\b/g, context: /voter|epic|election/i },
  { type: 'INDIAN_DL_LOCAL', kind: 'document', regex: /\b([A-Z]{2}[-\s]?\d{2}[-\s]?(?:19|20)\d{2}[-\s]?\d{7})\b/g },
  { type: 'GSTIN_LOCAL', kind: 'document', regex: /\b(\d{2}[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/g },
  { type: 'INDIAN_PASSPORT_LOCAL', kind: 'passport', regex: /\b([A-PR-WY][1-9]\d\s?\d{4}[1-9])\b/g, context: /passport/i },
  // The catalog DATE_OF_BIRTH knows only DD/MM/YYYY and DD-MM-YYYY. After a
  // birth label, ISO, dotted and written-month dates are dates of birth too.
  { type: 'DATE_OF_BIRTH_LOCAL', kind: 'date_of_birth', regex: new RegExp(String.raw`\b(?:d\.?\s*o\.?\s*b\.?|date\s+of\s+birth|birth\s*date|born(?:\s+on)?)\s*[:=-]?\s*(` +
    String.raw`\d{1,2}[./-]\d{1,2}[./-](?:19|20)?\d{2}|(?:19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2}|` +
    String.raw`\d{1,2}(?:st|nd|rd|th)?[\s-]+${month}\.?,?[\s-]+(?:19|20)\d{2}|${month}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:19|20)\d{2})(?!\d)`, 'gi') },
  // The catalog address needs a street suffix ('MG Road'), which Indian
  // addresses often lack ('Flat 4B, Sunrise Apartments'). After an address
  // label the rest of the line is the address, up to the next field label.
  // Email, IP and MAC addresses are not postal; a postal one carries a number.
  { type: 'ADDRESS_LABELED_LOCAL', kind: 'address',
    regex: /(?<!(?:e-?mail|ip|mac|web|wallet)[\s-]?)\b(?:(?:permanent|residential|present|current|correspondence|postal|mailing|home|office)\s+)?(?:address|addr\.?)\s*[:=-]\s*([^\n|]{6,160}?)(?=\s*(?:$|\n|\||\b(?:phone|mobile|tel|e-?mail|dob|date\s+of\s+birth|aadhaar|pan|pin\s*code)\b))/gi,
    validator: value => /\d/.test(value) },
  { type: 'BANK_ACCOUNT_LOCAL', kind: 'bank_account',
    regex: /\b(?:a\/c|account|acct)\.?\s*(?:no\.?|num(?:ber)?|#)?\s*[:=-]?\s*(\d(?:[\s-]?\d){8,17})(?![\s-]?\d)/gi },
];

// Credential labels. The pipeline requires password/otp/token/api_key
// detection (credentialKinds), but the pinned catalog has no OTP pattern and
// its GENERIC_SECRET validator rejects values that repeat the label word.
// These label markers supply that evidence by context (a labeled value
// follows) rather than by value shape. Help text is not a value: 'Password is
// required' and 'OTP is invalid' used to become [PASSWORD_1] and [OTP_1].
// The (?=\S) makes the separator take every space first; without it the
// separator could stop one space short and the lookahead saw ' required'.
// The value is one token (after an optional scheme word), so the rest of
// the line ('Remember me', 'Resend in 30s') stays readable.
const secretValue = String.raw`(?:(?:bearer|basic|token)\s+)?[^\s;,]{3,}`;
const notSecret = String.raw`(?!(?:required|incorrect|invalid|wrong|too|must|not|case|empty|missing|mandatory|expired|weak|strong|changed|reset|updated|sent|valid|correct|at\s+least|should|will|has|have|been|being|a|an|the|your|of|for|and|or)\b)`;
const credentialLabels: ReadonlyArray<readonly [PiiKind, RegExp]> = [
  ['password', new RegExp(String.raw`\b(?:password|passwd|pwd)\b\s*(?:is\b|[:=])\s*(?=\S)${notSecret}${secretValue}`, 'gi')],
  ['otp', new RegExp(String.raw`\b(?:otp|one[ -]time\s*(?:password|code)|verification\s+code)\b\s*(?:is\b|[:=])\s*(?=\S)${notSecret}${secretValue}`, 'gi')],
  // 'Your OTP 482913 expires' and '482913 is your OTP' carry no separator.
  ['otp', /\b(?:otp|one[ -]time\s*(?:password|code)|verification\s+code)\s*(?:is\s*)?[:=-]?\s*\d{4,8}\b/gi],
  ['otp', /\b\d{4,8}\s+is\s+(?:your|the)\s+(?:otp|one[ -]time\s*(?:password|code)|verification\s+code)\b/gi],
  ['api_key', new RegExp(String.raw`\b(?:api[ _-]?key|secret[ _-]?key|client[ _-]?secret)\b\s*(?:is\b|[:=])\s*(?=\S)${notSecret}${secretValue}`, 'gi')],
  ['token', new RegExp(String.raw`\b(?:authorization|bearer|access[ _-]?token|auth[ _-]?token|session[ _-]?(?:id|token))\b\s*(?:is\b|[:=])\s*(?=\S)${notSecret}${secretValue}`, 'gi')],
];

interface Candidate { start: number; end: number; kind: PiiKind; confidence: number }

function acceptName(value: string, before: string) {
  if (hasNotNameWord(value)) return false;
  if (nameAllCaps.test(value)) return true;
  return nameLabeled.test(value) && nameLabel.test(before) && !thingLabel.test(before);
}
// The longest leading run of words that passes acceptName, so a labeled name
// followed by a heading word ('Asha Rao Profile') keeps just 'Asha Rao'.
function namePrefix(value: string, before: string) {
  for (let count = value.split(/\s+/).length; count >= 2; count--) {
    const prefix = new RegExp(`^\\S+(?:\\s+\\S+){${count - 1}}`).exec(value)?.[0] ?? '';
    if (acceptName(prefix, before)) return prefix;
  }
  return '';
}
// The catalog NAME match is case-insensitive and starts at the first word it
// can, so in 'Logged in as Asha Rao' it takes the label words too and the name
// is never tested on its own. Greeting and session labels are therefore also
// read forward: the label, then up to four name words on the same line. The
// words are matched without the i flag, which would let \p{Lu} match
// lowercase letters.
const nameLabelForward = /\b(?:(?:logged|signed)\s+in\s+as|welcome(?:\s+back)?|hello|hi|hey|dear|(?:(?:full|first|last|middle|given|family|sur|applicant(?:'s)?|candidate(?:'s)?|student(?:'s)?|father(?:'s)?|mother(?:'s)?|guardian(?:'s)?|parent(?:'s)?|spouse(?:'s)?|nominee(?:'s)?|holder(?:'s)?|your|my)\s*)?name|student(?=\s*:))\b\s*[.:,-]?[ \t]*/gi;
const nameAfterLabel = new RegExp(String.raw`${nameToken}(?:[ \t]*${nameToken}){0,3}`, 'uy');

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
        const window = pattern.type === 'IBAN' ? '' : text.slice(Math.max(0, matchStart - 50), Math.min(text.length, matchEnd + 50));
        const context = validatorContext(pattern.type, window);
        // Some catalog patterns split the value across capture groups (IFSC's
        // bank code and branch suffix); their validators expect the full code.
        // Try the captured group first, then the whole match, so a candidate is
        // dropped only when both readings fail the pattern's own validator.
        const group = match[1] ?? match[0];
        const passes = (candidate: string) => !pattern.validator || pattern.validator(candidate, context);
        let value = passes(group) ? group : match[0] !== group && passes(match[0]) ? match[0] : '';
        if (!value || valueGuards[pattern.type]?.(value) === false) continue;
        const at = match[0].indexOf(value);
        let start = matchStart + (at >= 0 ? at : 0);
        if (pattern.type === 'NAME') {
          // The catalog NAME match runs up to four words, so a labeled name
          // followed by a heading word ('Asha Rao Profile') is retried
          // without its trailing words before being given up.
          value = namePrefix(value, text.slice(Math.max(0, start - 60), start));
          if (!value) continue;
        }
        const end = start + value.length;
        // The engine's stages after the validator: its false-positive filter
        // over the raw window around the value (years, ports, reserved example
        // domains, all-zero or sequential card numbers), then the context
        // score, which starts at 0.8 and moves with the surrounding words and
        // the kind of text (code, email, document).
        const falsePositive = isFalsePositive(value, pattern.type,
          text.slice(Math.max(0, start - 50), Math.min(text.length, end + 50)), falsePositiveRules);
        if (falsePositive.isFalsePositive && falsePositive.confidence >= FALSE_POSITIVE_THRESHOLD) continue;
        const { confidence } = analyzeFullContext(text, value, pattern.type, start, end);
        if (confidence < CONFIDENCE_THRESHOLD) continue;
        if (kind === 'phone') {
          // Catalog phone matches can start after '+' or '(' and leave '+1 ('
          // in front of the token; a hyphenated ISBN holds phone-like runs.
          const lead = /(?:\+\d{1,3}[\s.-]*\(?|\+|\()$/.exec(text.slice(Math.max(0, start - 8), start))?.[0] ?? '';
          if (/\bisbn(?:-?1[03])?\s*[:#]?\s*[\dx-]*$/i.test(text.slice(Math.max(0, start - 30), start))) continue;
          start -= lead.length;
        }
        const narrow = narrowContext[pattern.type];
        if (narrow && !narrow.test(window)) continue;
        push({ start, end, kind, confidence });
      }
    }
    for (const pattern of localPatterns) {
      for (const match of text.matchAll(new RegExp(pattern.regex.source, pattern.regex.flags))) {
        const value = match[1] ?? match[0];
        const start = match.index! + match[0].lastIndexOf(value);
        if (pattern.validator && !pattern.validator(value)) continue;
        if (pattern.context && !pattern.context.test(text.slice(Math.max(0, start - 50), Math.min(text.length, start + value.length + 50)))) continue;
        push({ start, end: start + value.length, kind: pattern.kind, confidence: pattern.validator ? .99 : .9 });
      }
    }
    for (const label of text.matchAll(new RegExp(nameLabelForward.source, nameLabelForward.flags))) {
      const start = label.index! + label[0].length;
      const words = new RegExp(nameAfterLabel.source, nameAfterLabel.flags);
      words.lastIndex = start;
      const value = namePrefix(words.exec(text)?.[0] ?? '', text.slice(Math.max(0, start - 60), start));
      if (value) push({ start, end: start + value.length, kind: 'person_name', confidence: .9 });
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
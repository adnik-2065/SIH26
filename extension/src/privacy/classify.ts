import { LIMITS, PrivacyError, type PiiKind } from './contracts';
import { additionalTextCandidates } from './openredaction';

export interface Span { start: number; end: number; kind: PiiKind;
  detector?: 'existing_text_detector' | 'openredaction'; confidence?: number }
export const credentialKinds = new Set<PiiKind>(['password', 'otp', 'token', 'api_key']);
export function canonical(raw: string) {
  if (raw.length > LIMITS.text) throw new PrivacyError('LIMIT_EXCEEDED');
  return raw.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
}
export function luhn(value: string) {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  let total = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if ((digits.length - 1 - i) % 2) { n *= 2; if (n > 9) n -= 9; }
    total += n;
  }
  return total % 10 === 0;
}

// Candidate rules, not identity/document validation. All spans are local only.
export function classify(raw: string): Span[] {
  const text = canonical(raw), spans: Span[] = [];
  const add = (kind: PiiKind, expression: RegExp, accept: (value: string) => boolean = () => true) => {
    for (const match of text.matchAll(expression)) if (accept(match[0])) spans.push({ start: match.index!, end: match.index! + match[0].length, kind });
  };
  add('password', /\b(?:password|passwd|pwd|recovery\s*code|private\s*key)\b\s*(?:is\s+|[:=]\s*)?[^\n;,]+/gi);
  add('otp', /\b(?:otp|one[ -]time\s*(?:password|code)|verification\s*code)\b\s*(?:is\s+|[:=]\s*)?[^\n;,]+/gi);
  add('api_key', /\b(?:api[ _-]?key|secret[ _-]?key|client[ _-]?secret)\b\s*(?:is\s+|[:=]\s*)?[^\n;,]+/gi);
  add('token', /\b(?:authorization|bearer|session[ _-]?(?:id|token)|access[ _-]?token|auth[ _-]?token)\b\s*(?:is\s+|[:=]\s*)?[^\n;,]+/gi);
  add('token', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g);
  add('api_key', /\b(?:sk[-_]|gh[pousr]_|AKIA)[A-Za-z0-9_-]{8,}\b/g);
  add('token', /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*/g);
  add('email', /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+\s*@\s*[\p{L}\p{N}-]+(?:\s*\.\s*[\p{L}\p{N}-]+)+/gu);
  add('pan', /\b[A-Z]{5}\s*\d{4}\s*[A-Z]\b/gi);
  add('ifsc', /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi);
  add('payment_card', /(?<!\d)(?:\d[\s-]?){12,18}\d(?!\d)/g, luhn);
  add('aadhaar', /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g);
  add('phone', /(?<![\p{L}\p{N}])\+?\d[\d\s().-]{7,}\d(?![\p{L}\p{N}])/gu, value => {
    const n = value.replace(/\D/g, '').length; return n >= 10 && n <= 15;
  });
  add('passport', /\b(?:passport\s*(?:number|no\.?)?\s*[:=]?\s*)[A-Z0-9 -]+/gi);
  add('bank_account', /\b(?:bank\s*account|account\s*(?:number|no\.?))\s*[:=]?\s*[\d -]+/gi);
  add('date_of_birth', /\b(?:dob|date\s*of\s*birth|born)\s*[:=]?\s*[^\n;,]+/gi);
  add('address', /\b(?:address|resides?\s+at|lives?\s+at)\s*[:=]?\s*[^\n;]+/gi);
  add('person_name', /\b(?:[Nn]ame\s*(?:is|:|=)|[Cc]ontact|[Dd]ear|[Aa]pplicant:)\s+\p{Lu}[\p{L}'-]*(?:\s+\p{Lu}[\p{L}'-]*){0,4}/gu);
  add('person_name', /\b(?:for|as|to|from|with)\s+\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+){0,4}/gu);
  add('address', /\b\d{1,6}\s+(?:[A-Za-z]+\s+){1,5}(?:street|st|road|rd|lane|ln|avenue|ave|drive|dr)\b[^\n;]*/gi);
  add('date_of_birth', /\b(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/g);
  add('passport', /\b[A-Z][0-9]{7}\b/g);
  // Long opaque strings and URLs are not useful planner context. They may be
  // credentials or private paths even when no familiar label is present.
  add('token', /\b[A-Za-z0-9_/-]{24,}\b/g);
  add('document', /(?:https?:\/\/|www\.)[^\s]+/gi);
  add('document', /\b(?:confidential|private\s+message|financial\s+details)\b[^\n]*/gi);
  return [...spans, ...additionalTextCandidates(text)].sort((a, b) => a.start - b.start || b.end - a.end);
}

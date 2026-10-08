import { z } from 'zod';
import type { ObservedElement } from '../contracts';
import { canonical, credentialKinds, openRedactionCandidates } from './openredaction';
import { BindingSchema, IdSchema, LIMITS, PrivacyError, type Binding, type Finding, type PiiKind } from './contracts';
import type { Placeholders } from './text';

export const LocalValueRecordSchema = z.object({ id: IdSchema, taskId: IdSchema, observationId: IdSchema, origin: z.string().url(),
  target: IdSchema, purpose: z.string().max(100), value: z.string().min(1).max(2000), expiresAt: z.number().finite() }).strict();
const ApprovalSchema = z.object({ source: z.literal('approved_profile'), approved: z.literal(true),
  kind: z.enum(['person_name', 'email', 'phone', 'address', 'date_of_birth']), value: z.string().min(1).max(2000),
  target: IdSchema }).strict();
const purposes = { person_name: 'Applicant name', email: 'Contact email', phone: 'Contact phone', address: 'Postal address', date_of_birth: 'Date of birth' };
const purposeKinds = Object.fromEntries(Object.entries(purposes).map(([kind, purpose]) => [purpose, kind])) as Record<string, PiiKind>;
export const sameBinding = (a: Binding, b: Binding) => (Object.keys(a) as Array<keyof Binding>).every(key => a[key] === b[key]);

export const transferKinds = ['person_name', 'email', 'phone', 'address', 'date_of_birth', 'document'] as const;
type TransferKind = typeof transferKinds[number];
// Local-only review data. Neither candidates nor records are wire contracts.
interface Candidate { id: string; kind: TransferKind; value: string; placeholder: string;
  source: 'dom' | 'ocr' | 'instruction' | 'user'; origin: string; reviewed: boolean }
interface TaskApproval { candidateId: string; approved: true; origins: string[]; purpose: 'contact' | 'recipient' | 'application' | 'message' }
interface TaskRecord extends Candidate { approvedAt: number; expiresAt: number; origins: string[]; purpose: TaskApproval['purpose'] }
export function compatibleValue(kind: TransferKind, element: ObservedElement): boolean {
  if (element.disabled || element.sensitive || element.credential || !['textbox', 'combobox', 'spinbutton'].includes(element.role) ||
    /password|otp|token|secret|verification|recovery/i.test(`${element.type} ${element.label}`)) return false;
  const text = `${element.type} ${element.label} ${element.autocomplete ?? ''}`.toLowerCase();
  const detected = /\bemail\b|e-mail|recipient/.test(text) ? 'email' : /\btel\b|phone|mobile|contact.number/.test(text) ? 'phone' :
    /address|postal|street/.test(text) ? 'address' : /birth|\bdate\b|bday/.test(text) ? 'date_of_birth' :
    /\bname\b/.test(text) ? 'person_name' : /identifier|reference|\bid\b/.test(text) ? 'document' : undefined;
  return detected === kind;
}

export class LocalValueVault {
  #records = new Map<string, z.infer<typeof LocalValueRecordSchema>>();
  #binding: Binding;
  #expiresAt: number;
  #timer: ReturnType<typeof setTimeout>;
  #closed = false;
  #candidates = new Map<string, Candidate>();
  #taskRecords = new Map<string, TaskRecord>();
  constructor(binding: Binding, private readonly signal: AbortSignal, private readonly current: () => Binding | undefined,
    private readonly now: () => number = Date.now, private readonly taskScoped = false) {
    const parsed = BindingSchema.safeParse(binding);
    if (!parsed.success) throw new PrivacyError('INVALID_REFERENCE');
    this.#binding = parsed.data; this.#expiresAt = now() + LIMITS.ttlMs;
    this.#timer = setTimeout(() => this.clear(), LIMITS.ttlMs);
    signal.addEventListener('abort', this.clear, { once: true });
    if (signal.aborted) this.clear();
  }
  #check() {
    const current = this.current();
    if (this.#closed || this.signal.aborted || this.now() >= this.#expiresAt || (!this.taskScoped && (!current || !sameBinding(this.#binding, current)))) {
      this.clear(); throw new PrivacyError('INVALID_REFERENCE');
    }
  }
  bind(binding: Binding, current: () => Binding | undefined) {
    this.#check();
    if (!this.taskScoped || binding.taskId !== this.#binding.taskId || binding.tabId !== this.#binding.tabId || !BindingSchema.safeParse(binding).success)
      throw new PrivacyError('INVALID_REFERENCE');
    if (!sameBinding(binding, this.#binding)) this.#records.clear(); // Never promote legacy profile approvals.
    this.#binding = binding; this.current = current;
  }
  capture(findings: Finding[], placeholders: Placeholders) {
    this.#check();
    if (!this.taskScoped) return;
    for (const finding of findings) {
      if (!finding.text || finding.unclassified || !transferKinds.includes(finding.kind as TransferKind) ||
        !['dom', 'ocr', 'instruction'].includes(finding.source) || finding.text.length > 2000 ||
        openRedactionCandidates(finding.text).some(span => credentialKinds.has(span.kind))) continue;
      const value = canonical(finding.text);
      if ([...this.#candidates.values()].some(item => item.kind === finding.kind && item.value === value)) continue;
      if (this.#candidates.size >= 100) throw new PrivacyError('LIMIT_EXCEEDED');
      const id = `candidate_${crypto.randomUUID()}`;
      this.#candidates.set(id, { id, kind: finding.kind as TransferKind, value,
        placeholder: placeholders.token(finding.kind, value), source: finding.source as Candidate['source'], origin: this.#binding.origin, reviewed: false });
    }
  }
  pending() { this.#check(); return [...this.#candidates.values()].filter(item => !item.reviewed).map(item => ({ ...item })); }
  dismiss(id: string) { this.#check(); const item = this.#candidates.get(id); if (item) item.reviewed = true; }
  approveTask(approval: TaskApproval) {
    this.#check();
    const item = this.#candidates.get(approval.candidateId);
    if (!this.taskScoped || !item || approval.approved !== true || !['contact', 'recipient', 'application', 'message'].includes(approval.purpose) ||
      !approval.origins.length || approval.origins.length > 20 || approval.origins.some(origin => {
        try { const url = new URL(origin); return !/^https?:$/.test(url.protocol) || url.origin !== origin; } catch { return true; }
      })) throw new PrivacyError('INVALID_REFERENCE');
    const existing = [...this.#taskRecords.entries()].find(([, record]) => record.id === item.id);
    if (existing) return existing[0];
    const id = `value_${crypto.randomUUID()}`;
    this.#taskRecords.set(id, { ...item, origins: [...new Set(approval.origins)], purpose: approval.purpose, approvedAt: this.now(), expiresAt: this.#expiresAt });
    item.reviewed = true;
    return id;
  }
  approve(raw: z.infer<typeof ApprovalSchema>, element: ObservedElement) {
    this.#check();
    const parsed = ApprovalSchema.safeParse(raw);
    if (!parsed.success) throw new PrivacyError('INVALID_REFERENCE');
    const approval = parsed.data;
    const value = canonical(approval.value);
    const matchesKind = approval.kind === 'person_name' ? /^[\p{L}][\p{L} .'-]{1,99}$/u.test(value) :
      approval.kind === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) :
      approval.kind === 'phone' ? /^\+?[\d ()-]{10,20}$/.test(value) && value.replace(/\D/g, '').length >= 10 :
      approval.kind === 'date_of_birth' ? /^\d{4}-\d{2}-\d{2}$/.test(value) : /[\p{L}]/u.test(value) && value.length >= 8;
    if (element.id !== approval.target || element.sensitive || element.disabled || element.label.length >= 200 ||
      !['textbox', 'combobox', 'spinbutton'].includes(element.role) ||
      /password|otp|token|secret|key|recovery|verification/i.test(`${element.type} ${element.label}`) ||
      !matchesKind || openRedactionCandidates(approval.value).some(span => credentialKinds.has(span.kind)) || this.#records.size >= 100) throw new PrivacyError('INVALID_REFERENCE');
    // Only explicit profile approval enters here. Page normalization has no
    // route into this method, and never promotes detected values to references.
    const id = `value_${crypto.randomUUID()}`;
    const record = LocalValueRecordSchema.parse({ id, taskId: this.#binding.taskId, observationId: this.#binding.observationId,
      origin: this.#binding.origin, target: approval.target, purpose: purposes[approval.kind], value: canonical(approval.value), expiresAt: this.#expiresAt });
    this.#records.set(id, record); return id;
  }
  references(binding: Binding) {
    this.#check();
    if (!sameBinding(this.#binding, binding)) throw new PrivacyError('INVALID_REFERENCE');
    return [...this.#records.values()].map(({ id, purpose, target }) => ({ id, purpose, target } as { id: string; purpose: string; target?: string; placeholder?: string })).concat(
      [...this.#taskRecords].map(([id, record]) => ({ id, purpose: `${record.purpose} ${record.kind === 'person_name' ? 'name' : record.kind === 'document' ? 'reference' : record.kind === 'date_of_birth' ? 'date' : record.kind}`, placeholder: record.placeholder })));
  }
  resolve(id: string, binding: Binding, target: string, element?: ObservedElement) {
    this.#check();
    const task = this.#taskRecords.get(id);
    if (task) {
      const current = this.current();
      if (!current || !sameBinding(current, binding) || !sameBinding(this.#binding, binding) || !task.origins.includes(binding.origin) ||
        this.now() >= task.expiresAt || !element || element.id !== target || !compatibleValue(task.kind, element)) throw new PrivacyError('INVALID_REFERENCE');
      return task.value;
    }
    const record = this.#records.get(id);
    if (!record || !sameBinding(this.#binding, binding) || record.target !== target) throw new PrivacyError('INVALID_REFERENCE');
    return record.value;
  }
  // Local leak scanner only; no serialization API and private records.
  hasLeak(text: string) {
    this.#check();
    const value = canonical(text).toLowerCase().replace(/\s/g, '');
    return this.#values().some(record => value.includes(record.value.toLowerCase().replace(/\s/g, '')));
  }
  // Replaces approved values in outgoing text with their placeholder tokens,
  // so an instruction that repeats the user's own name is rewritten rather
  // than refused. The values never leave this class.
  scrub(text: string, placeholders: Placeholders) {
    this.#check();
    return placeholders.scrub(text, this.#values().map(record => ({ kind: record.kind, text: record.value })));
  }
  #values() { return [...this.#records.values()].map(record => ({ value: record.value, kind: purposeKinds[record.purpose] ?? 'document' })).concat(
    [...this.#candidates.values()].map(record => ({ value: record.value, kind: record.kind }))); }
  // Known-value matching supplements detection; it never relaxes sanitizeText.
  matches(text: string) {
    this.#check();
    return this.#values().flatMap(record => {
      const pattern = [...record.value.replace(/\s/g, '')].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
      return pattern ? [...text.matchAll(new RegExp(pattern, 'giu'))].map(match => ({ kind: record.kind, start: match.index!, end: match.index! + match[0].length, text: match[0] })) : [];
    });
  }
  clear = () => { this.#closed = true; this.#records.clear(); this.#taskRecords.clear(); this.#candidates.clear(); clearTimeout(this.#timer); this.signal.removeEventListener('abort', this.clear); };
}

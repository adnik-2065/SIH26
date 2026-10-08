import { z } from 'zod';
import type { ObservedElement } from '../contracts';
import { canonical, credentialKinds, openRedactionCandidates } from './openredaction';
import { BindingSchema, IdSchema, LIMITS, PrivacyError, type Binding } from './contracts';

export const LocalValueRecordSchema = z.object({ id: IdSchema, taskId: IdSchema, observationId: IdSchema, origin: z.string().url(),
  target: IdSchema, purpose: z.string().max(100), value: z.string().min(1).max(2000), expiresAt: z.number().finite() }).strict();
const ApprovalSchema = z.object({ source: z.literal('approved_profile'), approved: z.literal(true),
  kind: z.enum(['person_name', 'email', 'phone', 'address', 'date_of_birth']), value: z.string().min(1).max(2000),
  target: IdSchema }).strict();
const purposes = { person_name: 'Applicant name', email: 'Contact email', phone: 'Contact phone', address: 'Postal address', date_of_birth: 'Date of birth' };
export const sameBinding = (a: Binding, b: Binding) => (Object.keys(a) as Array<keyof Binding>).every(key => a[key] === b[key]);

export class LocalValueVault {
  #records = new Map<string, z.infer<typeof LocalValueRecordSchema>>();
  #binding: Binding;
  #expiresAt: number;
  #timer: ReturnType<typeof setTimeout>;
  #closed = false;
  constructor(binding: Binding, private readonly signal: AbortSignal, private readonly current: () => Binding | undefined,
    private readonly now: () => number = Date.now) {
    const parsed = BindingSchema.safeParse(binding);
    if (!parsed.success) throw new PrivacyError('INVALID_REFERENCE');
    this.#binding = parsed.data; this.#expiresAt = now() + LIMITS.ttlMs;
    this.#timer = setTimeout(() => this.clear(), LIMITS.ttlMs);
    signal.addEventListener('abort', this.clear, { once: true });
    if (signal.aborted) this.clear();
  }
  #check() {
    const current = this.current();
    if (this.#closed || this.signal.aborted || this.now() >= this.#expiresAt || !current || !sameBinding(this.#binding, current)) {
      this.clear(); throw new PrivacyError('INVALID_REFERENCE');
    }
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
    return [...this.#records.values()].map(({ id, purpose, target }) => ({ id, purpose, target }));
  }
  resolve(id: string, binding: Binding, target: string) {
    this.#check(); const record = this.#records.get(id);
    if (!record || !sameBinding(this.#binding, binding) || record.target !== target) throw new PrivacyError('INVALID_REFERENCE');
    return record.value;
  }
  // Local leak scanner only; no serialization API and private records.
  hasLeak(text: string) {
    this.#check();
    const value = canonical(text).toLowerCase().replace(/\s/g, '');
    return [...this.#records.values()].some(record => value.includes(record.value.toLowerCase().replace(/\s/g, '')));
  }
  clear = () => { this.#closed = true; this.#records.clear(); clearTimeout(this.#timer); this.signal.removeEventListener('abort', this.clear); };
}

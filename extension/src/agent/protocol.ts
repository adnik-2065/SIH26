import { AgentResponseSchema, ActionSchema, type Action, type StepRequest, type TransportError } from '../contracts';
import { canonical, classify, credentialKinds } from '../privacy/classify';
import { transportError } from './diagnostics';

// Why a step was refused. These are shown to the user, never sent anywhere.
export const rejections = ['UNKNOWN_TARGET', 'SELECTOR_UNSUPPORTED', 'MISSING_VALUE', 'UNSAFE_VALUE',
  'SENSITIVE_TARGET', 'INVALID_ACTION', 'AFTER_FINISH'] as const;
export type Rejection = typeof rejections[number];
export interface PlannedStep { action: Action; index: number; literal: boolean }
// A refusal carries both the coarse reason older callers read and the exact
// code, stage and structural context that say what was wrong with the reply.
export type PlanFailure = { ok: false; reason: 'MALFORMED_RESPONSE' | 'WRONG_REQUEST'; error: TransportError };
export type PlanSuccess = { ok: true; thought: string; steps: PlannedStep[]; rejected: Array<{ index: number; reason: Rejection }> };
export type Plan = PlanSuccess | PlanFailure;

// A server may only name a control the redaction gateway actually exported,
// and only for the observation this response answers. Everything else about
// the page — markup, class names, structure — it never received.
export function planActions(raw: unknown, request: StepRequest, runId?: string): Plan {
  const parsed = AgentResponseSchema.safeParse(raw);
  if (!parsed.success) {
    // Field paths and issue codes only. The offending values are the server's
    // prose and can echo page vocabulary, so they stay out of the diagnostics.
    const issues = parsed.error.issues.slice(0, 8).map(issue => ({ path: issue.path.join('.') || '(root)', code: issue.code }));
    return { ok: false, reason: 'MALFORMED_RESPONSE', error: transportError({
      code: 'AGENT_RESPONSE_SCHEMA_INVALID', stage: 'response_validated', runId,
      message: 'The reply did not match the agent response schema.',
      cause: `${parsed.error.issues.length} schema issue${parsed.error.issues.length === 1 ? '' : 's'}`,
      context: { schema: 'AgentResponseSchema', issues, replyType: raw === null ? 'null' : typeof raw },
    }) };
  }
  const response = parsed.data;
  for (const [key, value] of [['requestId', response.requestId], ['taskId', response.taskId], ['observationId', response.observationId]] as const)
    if (value !== undefined && value !== request[key]) return { ok: false, reason: 'WRONG_REQUEST', error: transportError({
      code: 'AGENT_PLAN_VALIDATION_FAILED', stage: 'plan_validated', runId,
      message: 'The reply echoes a different request than the one in flight.',
      cause: `${key} does not match the request`, context: { mismatchedField: key },
    }) };
  const elements = new Map(request.elements.map(element => [element.id, element]));
  const valueRefs = new Map(request.valueRefs.map(ref => [ref.id, ref]));
  const steps: PlannedStep[] = [], rejected: Array<{ index: number; reason: Rejection }> = [];
  let finished = false;
  for (const [index, step] of response.output.entries()) {
    const refuse = (reason: Rejection) => { rejected.push({ index, reason }); };
    if (finished) { refuse('AFTER_FINISH'); continue; }
    const value = step.value ?? '';
    // Addressing. An id we minted resolves; a class or xpath cannot, because
    // we never disclosed either and cannot check what it would select.
    const element = step.id ? elements.get(step.id) : undefined;
    const needsTarget = step.action === 'click' || step.action === 'type' || step.action === 'select';
    if (needsTarget && !element) { refuse(step.id ? 'UNKNOWN_TARGET' : step.className || step.xpath ? 'SELECTOR_UNSUPPORTED' : 'UNKNOWN_TARGET'); continue; }
    const target = element?.id ?? '';
    if (step.action === 'finish') { finished = true; steps.push({ action: { type: 'done' }, index, literal: false }); continue; }
    if (step.action === 'wait') {
      // A bare "wait" with no number is the common model output.
      const milliseconds = Math.min(5000, Math.max(1, Math.round(Number(value) || 500)));
      steps.push({ action: { type: 'wait', milliseconds }, index, literal: false }); continue;
    }
    if (step.action === 'scroll') {
      const direction = /up/i.test(value) ? 'up' : 'down';
      const pixels = Math.min(2000, Math.max(1, Math.round(Math.abs(Number(value.replace(/[^\d.-]/g, ''))) || 600)));
      steps.push({ action: { type: 'scroll', direction, pixels }, index, literal: false }); continue;
    }
    if (step.action === 'click') { steps.push({ action: { type: 'click', target }, index, literal: false }); continue; }
    if (!value) { refuse('MISSING_VALUE'); continue; }
    // An approved private value travels as the reference the vault minted; the
    // server never holds it. Anything else is literal text it composed itself.
    const reference = valueRefs.get(value);
    if (reference) {
      if (reference.target !== target) { refuse('UNKNOWN_TARGET'); continue; }
      steps.push({ action: { type: step.action === 'type' ? 'fill' : 'select', target, ...(step.action === 'type' ? { valueRef: value } : { optionRef: value }) } as Action, index, literal: false });
      continue;
    }
    if (element && /sensitive/i.test(element.description)) { refuse('SENSITIVE_TARGET'); continue; }
    if (!literalTextAllowed(value)) { refuse('UNSAFE_VALUE'); continue; }
    const text = canonical(value).slice(0, 200);
    if (!text) { refuse('MISSING_VALUE'); continue; }
    steps.push({ action: step.action === 'type' ? { type: 'type', target, text } : { type: 'choose', target, optionText: text }, index, literal: true });
  }
  for (const step of steps) {
    const action = ActionSchema.safeParse(step.action);
    if (!action.success) return { ok: false, reason: 'MALFORMED_RESPONSE', error: transportError({
      code: 'AGENT_PLAN_VALIDATION_FAILED', stage: 'plan_validated', runId,
      message: 'A translated step did not satisfy the local action contract.',
      cause: 'ActionSchema rejected a translated step',
      context: { schema: 'ActionSchema', stepIndex: step.index, actionType: step.action.type,
        issues: action.error.issues.slice(0, 4).map(issue => ({ path: issue.path.join('.') || '(root)', code: issue.code })) },
    }) };
  }
  return { ok: true, thought: canonical(response.thought).slice(0, 2000), steps, rejected };
}

// Literal text is keyed into a real page, so a server cannot use it to plant a
// credential, nor to echo back personal data that redaction just removed.
export function literalTextAllowed(value: string) {
  const text = canonical(value);
  if (!text || text.length > 200) return false;
  return !classify(text).some(span => credentialKinds.has(span.kind) ||
    ['aadhaar', 'pan', 'passport', 'payment_card', 'bank_account', 'ifsc'].includes(span.kind));
}

// A batch is a plan, not a script. Clicking, typing or even scrolling retires
// the element map the rest of the batch was planned against, so exactly one
// page-touching step runs per observation; `wait` alone may lead it. The
// remainder is deferred until a fresh scan has been captured and redacted.
export function executableNow(steps: PlannedStep[]) {
  const runnable: PlannedStep[] = [];
  for (const step of steps) {
    runnable.push(step);
    if (step.action.type !== 'wait') break;
  }
  return { runnable, deferred: steps.slice(runnable.length) };
}

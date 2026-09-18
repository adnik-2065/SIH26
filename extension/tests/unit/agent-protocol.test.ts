import { describe, expect, it, vi } from 'vitest';
import { executableNow, literalTextAllowed, planActions } from '../../src/agent/protocol';
import { endpointAllowed, requestStep } from '../../src/agent/transport';
import { describePage, toAgentBody, unwrapReply } from '../../src/agent/wire';
import type { StepRequest } from '../../src/contracts';

const request: StepRequest = { protocolVersion: 1, requestId: 'request_1', taskId: 'task_1', observationId: 'obs_1',
  sanitizedInstruction: 'Register for the workshop',
  elements: [
    { id: 'obs_1_e1', role: 'textbox', description: 'Full name' },
    { id: 'obs_1_e2', role: 'textbox', description: 'Sensitive field' },
    { id: 'obs_1_e3', role: 'combobox', description: 'Session' },
    { id: 'obs_1_e4', role: 'button', description: 'Submit' },
  ],
  valueRefs: [{ id: 'value_1', purpose: 'Applicant name', target: 'obs_1_e1' }] };
const reply = (output: unknown[], extra: object = {}) => ({ thought: 'The form needs a name and a submit.', output, ...extra });
// The live server wraps its answer in `response`. Transport tests go through
// that wrapper so a change to either shape fails here first.
const wrapped = (output: unknown[], extra: object = {}) => ({ response: reply(output, extra) });

describe('translating a server response into actions', () => {
  it('maps the documented wire shape onto the local action contract', () => {
    const plan = planActions(reply([
      { action: 'type', id: 'obs_1_e1', className: null, xpath: null, value: 'Demo Student' },
      { action: 'select', id: 'obs_1_e3', className: null, xpath: null, value: 'Morning' },
      { action: 'click', id: 'obs_1_e4', className: null, xpath: null, value: null },
      { action: 'finish', id: null, className: null, xpath: null, value: null },
    ]), request);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.steps.map(step => step.action)).toEqual([
      { type: 'type', target: 'obs_1_e1', text: 'Demo Student' },
      { type: 'choose', target: 'obs_1_e3', optionText: 'Morning' },
      { type: 'click', target: 'obs_1_e4' },
      { type: 'done' },
    ]);
    expect(plan.rejected).toEqual([]);
  });
  it('resolves a value reference to the local fill action and keeps its destination', () => {
    const plan = planActions(reply([{ action: 'type', id: 'obs_1_e1', value: 'value_1' }]), request);
    expect(plan.ok && plan.steps[0].action).toEqual({ type: 'fill', target: 'obs_1_e1', valueRef: 'value_1' });
    // The vault minted that reference for e1; it cannot be redirected elsewhere.
    const moved = planActions(reply([{ action: 'type', id: 'obs_1_e3', value: 'value_1' }]), request);
    expect(moved.ok && moved.rejected).toEqual([{ index: 0, reason: 'UNKNOWN_TARGET' }]);
  });
  it.each([
    ['an id never exported', { action: 'click', id: 'obs_1_e9' }, 'UNKNOWN_TARGET'],
    ['a class selector', { action: 'click', id: null, className: 'btn-primary' }, 'SELECTOR_UNSUPPORTED'],
    ['an xpath', { action: 'click', id: null, xpath: '//button[@type="submit"]' }, 'SELECTOR_UNSUPPORTED'],
    ['an id from another observation', { action: 'click', id: 'obs_2_e1' }, 'UNKNOWN_TARGET'],
  ])('refuses to address a control by %s', (_label, step, reason) => {
    const plan = planActions(reply([step]), request);
    expect(plan.ok && plan.steps).toEqual([]);
    expect(plan.ok && plan.rejected).toEqual([{ index: 0, reason }]);
  });
  it('refuses literal text aimed at a sensitive field or carrying a secret', () => {
    const plan = planActions(reply([
      { action: 'type', id: 'obs_1_e2', value: 'hunter2' },
      { action: 'type', id: 'obs_1_e1', value: 'password: hunter2' },
      { action: 'type', id: 'obs_1_e1', value: '4111 1111 1111 1111' },
      { action: 'type', id: 'obs_1_e1', value: '' },
    ]), request);
    expect(plan.ok && plan.steps).toEqual([]);
    expect(plan.ok && plan.rejected).toEqual([{ index: 0, reason: 'SENSITIVE_TARGET' }, { index: 1, reason: 'UNSAFE_VALUE' },
      { index: 2, reason: 'UNSAFE_VALUE' }, { index: 3, reason: 'MISSING_VALUE' }]);
  });
  it('supplies defaults for the bare wait and scroll a model usually emits', () => {
    const plan = planActions(reply([{ action: 'wait', value: null }, { action: 'scroll', value: 'down 900' },
      { action: 'scroll', value: 'up' }, { action: 'wait', value: '99999' }]), request);
    expect(plan.ok && plan.steps.map(step => step.action)).toEqual([
      { type: 'wait', milliseconds: 500 }, { type: 'scroll', direction: 'down', pixels: 900 },
      { type: 'scroll', direction: 'up', pixels: 600 }, { type: 'wait', milliseconds: 5000 }]);
  });
  it('ignores anything the model appends after it said it had finished', () => {
    const plan = planActions(reply([{ action: 'finish' }, { action: 'click', id: 'obs_1_e4' }]), request);
    expect(plan.ok && plan.steps.map(step => step.action)).toEqual([{ type: 'done' }]);
    expect(plan.ok && plan.rejected).toEqual([{ index: 1, reason: 'AFTER_FINISH' }]);
  });
  it.each([
    ['unknown action verbs', reply([{ action: 'navigate', value: 'https://example.test' }])],
    ['injected script fields', reply([{ action: 'click', id: 'obs_1_e4', script: 'alert(1)' }])],
    ['a missing output list', { thought: 'done' }],
    ['an empty output list', reply([])],
    ['prose instead of JSON', 'I will click the submit button'],
  ])('rejects %s outright', (_label, payload) => {
    expect(planActions(payload, request)).toEqual({ ok: false, reason: 'MALFORMED_RESPONSE' });
  });
  it('rejects a reply that echoes a different request', () => {
    expect(planActions(reply([{ action: 'finish' }], { requestId: 'request_9' }), request)).toEqual({ ok: false, reason: 'WRONG_REQUEST' });
    expect(planActions(reply([{ action: 'finish' }], { observationId: 'obs_9' }), request)).toEqual({ ok: false, reason: 'WRONG_REQUEST' });
    expect(planActions(reply([{ action: 'finish' }], { requestId: 'request_1', taskId: 'task_1' }), request).ok).toBe(true);
  });
  it('runs one page-touching step per observation and defers the rest', () => {
    const plan = planActions(reply([{ action: 'wait', value: '200' }, { action: 'type', id: 'obs_1_e1', value: 'Demo Student' },
      { action: 'click', id: 'obs_1_e4' }, { action: 'finish' }]), request);
    if (!plan.ok) throw new Error('expected a plan');
    const { runnable, deferred } = executableNow(plan.steps);
    expect(runnable.map(step => step.action.type)).toEqual(['wait', 'type']);
    expect(deferred.map(step => step.action.type)).toEqual(['click', 'done']);
  });
  it('keeps ordinary form text usable', () => {
    for (const value of ['Demo Student', '2026-01-01', 'Morning session', 'Room 4B']) expect(literalTextAllowed(value)).toBe(true);
    for (const value of ['', 'x'.repeat(201), 'OTP is 123456']) expect(literalTextAllowed(value)).toBe(false);
  });
});

describe('sending the redacted payload', () => {
  const ok = (body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const signal = () => new AbortController().signal;
  it('posts a body built only from the redacted payload and returns the translated plan', async () => {
    const fetchImpl = ok(wrapped([{ action: 'click', id: 'obs_1_e4' }]));
    const result = await requestStep({ endpoint: 'https://agent.example.test/step', request, signal: signal(), fetchImpl });
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://agent.example.test/step');
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(['instruction', 'page_info', 'problem_context', 'ss']);
    expect(body.instruction).toBe(request.sanitizedInstruction);
    expect(body.ss).toBeNull();
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
  });
  it.each([
    ['http://tracker.example.test/step', false], ['https://agent.example.test/step', true],
    ['http://127.0.0.1:8000/step', true], ['http://localhost:8000/step', true],
    ['file:///tmp/step', false], ['not a url', false],
  ])('allows %s: %s', (endpoint, allowed) => expect(endpointAllowed(endpoint)).toBe(allowed));
  it('refuses a plain http endpoint before any payload is built', async () => {
    const fetchImpl = ok(wrapped([{ action: 'finish' }]));
    expect(await requestStep({ endpoint: 'http://tracker.example.test/step', request, signal: signal(), fetchImpl }))
      .toEqual({ ok: false, reason: 'ENDPOINT_REJECTED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    ['a server error', vi.fn().mockResolvedValue(new Response('no', { status: 500 })), 'SERVER_REFUSED'],
    ['an unreachable server', vi.fn().mockRejectedValue(new Error('offline')), 'SERVER_UNREACHABLE'],
    ['a non-JSON body', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })), 'MALFORMED_RESPONSE'],
  ])('fails closed on %s', async (_label, fetchImpl, reason) => {
    expect(await requestStep({ endpoint: 'https://agent.example.test/step', request, signal: signal(), fetchImpl }))
      .toEqual({ ok: false, reason });
  });
  it('refuses an oversized reply instead of parsing it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('x'.repeat(200_001), { status: 200 }));
    expect(await requestStep({ endpoint: 'https://agent.example.test/step', request, signal: signal(), fetchImpl }))
      .toEqual({ ok: false, reason: 'RESPONSE_TOO_LARGE' });
  });
  it('abandons the call when the task stops', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation((_url, init: RequestInit) => new Promise((_resolve, rejectCall) => {
      init.signal?.addEventListener('abort', () => rejectCall(new Error('aborted')));
    }));
    const pending = requestStep({ endpoint: 'https://agent.example.test/step', request, signal: controller.signal, fetchImpl });
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'SERVER_UNREACHABLE' });
  });
});

describe('the body sent to the reasoning server', () => {
  it('is assembled only from fields the privacy gateway already cleared', () => {
    const body = toAgentBody({ ...request, sanitizedImage: { mimeType: 'image/png', base64: 'AAAA' } });
    expect(Object.keys(body).sort()).toEqual(['instruction', 'page_info', 'problem_context', 'ss']);
    expect(body.instruction).toBe('Register for the workshop');
    expect(body.ss).toBe('AAAA');
    // Every addressable name in the description is an opaque observation id.
    for (const id of body.page_info.match(/id=\S+/g) ?? []) expect(request.elements.some(element => id === `id=${element.id}`)).toBe(true);
    expect(body.page_info).toContain('value_1 fills obs_1_e1');
    expect(body.problem_context).toContain('Never invent an id');
  });
  it('describes an empty view without pretending controls exist', () => {
    expect(describePage({ ...request, elements: [], valueRefs: [] })).toContain('no interactive element');
  });
  it('accepts the wrapped reply the server sends and a flat one', () => {
    const answer = { thought: 'ok', output: [] };
    expect(unwrapReply({ response: answer })).toEqual(answer);
    expect(unwrapReply({ response: JSON.stringify(answer) })).toEqual(answer);
    expect(unwrapReply(answer)).toEqual(answer);
  });
});

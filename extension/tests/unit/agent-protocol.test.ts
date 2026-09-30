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
  it('accepts a back step with no id as the wrong-destination recovery', () => {
    const plan = planActions(reply([
      { action: 'back', id: null, className: null, xpath: null, value: null },
      { action: 'back' },
      { action: 'back', id: 'obs_1_e9' },
    ]), request);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // Back never addresses a control: an id is neither required nor resolved.
    expect(plan.steps.map(step => step.action)).toEqual([{ type: 'back' }, { type: 'back' }, { type: 'back' }]);
    expect(plan.rejected).toEqual([]);
  });
  it('runs a back step immediately and defers the steps planned after it', () => {
    const plan = planActions(reply([{ action: 'back' }, { action: 'click', id: 'obs_1_e4' }, { action: 'finish' }]), request);
    if (!plan.ok) throw new Error('expected a plan');
    const { runnable, deferred } = executableNow(plan.steps);
    expect(runnable.map(step => step.action.type)).toEqual(['back']);
    expect(deferred.map(step => step.action.type)).toEqual(['click', 'done']);
  });
  it('opens a normalized http(s) address and ends the batch there', () => {
    const plan = planActions(reply([
      { action: 'type', id: 'obs_1_e1', value: 'Demo Student' },
      { action: 'navigate', value: 'en.wikipedia.org/wiki/Artificial_intelligence' },
      { action: 'click', id: 'obs_1_e4' },
    ]), request);
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.steps[1].action).toEqual({ type: 'navigate', url: 'https://en.wikipedia.org/wiki/Artificial_intelligence' });
    const { runnable, deferred } = executableNow(plan.steps);
    expect(runnable.map(step => step.action.type)).toEqual(['type', 'navigate']);
    expect(deferred.map(step => step.action.type)).toEqual(['click']);
  });
  it.each([
    ['javascript:alert(1)', 'INVALID_ACTION'],
    ['JavaScript:alert(1)', 'INVALID_ACTION'],
    ['data:text/html,<script>alert(1)</script>', 'INVALID_ACTION'],
    ['file:///etc/passwd', 'INVALID_ACTION'],
    ['chrome://settings', 'INVALID_ACTION'],
    ['https://user:secret@example.com/', 'INVALID_ACTION'],
    ['https://exa mple.com/', 'INVALID_ACTION'],
    ['', 'MISSING_VALUE'],
    ['https://example.com/?card=4111%201111%201111%201111', 'UNSAFE_VALUE'],
  ])('refuses the address %j', (value, reason) => {
    const plan = planActions(reply([{ action: 'navigate', value }]), request);
    expect(plan.ok && plan.steps).toEqual([]);
    expect(plan.ok && plan.rejected).toEqual([{ index: 0, reason }]);
  });
  it('ignores anything the model appends after it said it had finished', () => {
    const plan = planActions(reply([{ action: 'finish' }, { action: 'click', id: 'obs_1_e4' }]), request);
    expect(plan.ok && plan.steps.map(step => step.action)).toEqual([{ type: 'done' }]);
    expect(plan.ok && plan.rejected).toEqual([{ index: 1, reason: 'AFTER_FINISH' }]);
  });
  it.each([
    ['unknown action verbs', reply([{ action: 'download', value: 'https://example.test/file' }])],
    ['injected script fields', reply([{ action: 'click', id: 'obs_1_e4', script: 'alert(1)' }])],
    ['a missing output list', { thought: 'done' }],
    ['an empty output list', reply([])],
    ['prose instead of JSON', 'I will click the submit button'],
  ])('rejects %s outright', (_label, payload) => {
    expect(planActions(payload, request)).toMatchObject({ ok: false, reason: 'MALFORMED_RESPONSE',
      error: { code: 'AGENT_RESPONSE_SCHEMA_INVALID', stage: 'response_validated' } });
  });
  it('rejects a reply that echoes a different request', () => {
    expect(planActions(reply([{ action: 'finish' }], { requestId: 'request_9' }), request)).toMatchObject({ ok: false, reason: 'WRONG_REQUEST',
      error: { code: 'AGENT_PLAN_VALIDATION_FAILED', context: { mismatchedField: 'requestId' } } });
    expect(planActions(reply([{ action: 'finish' }], { observationId: 'obs_9' }), request)).toMatchObject({ ok: false, reason: 'WRONG_REQUEST' });
    expect(planActions(reply([{ action: 'finish' }], { requestId: 'request_1', taskId: 'task_1' }), request).ok).toBe(true);
  });
  it('runs field entries and one page-touching step per observation and defers the rest', () => {
    const plan = planActions(reply([{ action: 'wait', value: '200' }, { action: 'type', id: 'obs_1_e1', value: 'Demo Student' },
      { action: 'click', id: 'obs_1_e4' }, { action: 'finish' }]), request);
    if (!plan.ok) throw new Error('expected a plan');
    const { runnable, deferred } = executableNow(plan.steps);
    expect(runnable.map(step => step.action.type)).toEqual(['wait', 'type', 'click']);
    expect(deferred.map(step => step.action.type)).toEqual(['done']);
  });
  it.each([
    ['a click ends the batch before a field entry', [{ action: 'click', id: 'obs_1_e4' }, { action: 'type', id: 'obs_1_e1', value: 'Demo Student' }], ['click'], ['type']],
    ['field entries lead a key press', [{ action: 'type', id: 'obs_1_e1', value: 'Demo' }, { action: 'type', id: 'obs_1_e1', value: 'Student' },
      { action: 'key', id: 'obs_1_e1', value: 'Enter' }, { action: 'finish' }], ['type', 'type', 'key'], ['done']],
    ['a scroll ends the batch', [{ action: 'scroll', value: 'down' }, { action: 'click', id: 'obs_1_e4' }], ['scroll'], ['click']],
  ])('%s', (_label, output, now, later) => {
    const plan = planActions(reply(output), request);
    if (!plan.ok) throw new Error('expected a plan');
    const { runnable, deferred } = executableNow(plan.steps);
    expect(runnable.map(step => step.action.type)).toEqual(now);
    expect(deferred.map(step => step.action.type)).toEqual(later);
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
    expect(Object.keys(body).sort()).toEqual(['action_history', 'instruction', 'page_info', 'problem_context', 'ss']);
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
      .toMatchObject({ ok: false, reason: 'ENDPOINT_REJECTED', error: { code: 'AGENT_ENDPOINT_REJECTED' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    ['a server error', () => vi.fn().mockResolvedValue(new Response('no', { status: 500 })), 'SERVER_REFUSED', 'AGENT_HTTP_ERROR'],
    ['an unreachable server', () => vi.fn().mockRejectedValue(new Error('offline')), 'SERVER_UNREACHABLE', 'AGENT_UNKNOWN_ERROR'],
    ['a non-JSON body', () => vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })), 'MALFORMED_RESPONSE', 'AGENT_JSON_PARSE_FAILED'],
  ])('fails closed on %s', async (_label, fetchImpl, reason, code) => {
    expect(await requestStep({ endpoint: 'https://agent.example.test/step', request, signal: signal(), fetchImpl: fetchImpl() }))
      .toMatchObject({ ok: false, reason, error: { code } });
  });
  it('refuses an oversized reply instead of parsing it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('x'.repeat(200_001), { status: 200 }));
    expect(await requestStep({ endpoint: 'https://agent.example.test/step', request, signal: signal(), fetchImpl }))
      .toMatchObject({ ok: false, reason: 'RESPONSE_TOO_LARGE', error: { code: 'AGENT_RESPONSE_TOO_LARGE' } });
  });
  it('abandons the call when the task stops', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation((_url, init: RequestInit) => new Promise((_resolve, rejectCall) => {
      init.signal?.addEventListener('abort', () => rejectCall(new Error('aborted')));
    }));
    const pending = requestStep({ endpoint: 'https://agent.example.test/step', request, signal: controller.signal, fetchImpl });
    controller.abort();
    // The category older callers read is unchanged; the cancellation itself is
    // now named, so it can no longer be mistaken for an unreachable server.
    expect(await pending).toMatchObject({ ok: false, reason: 'SERVER_UNREACHABLE',
      error: { code: 'AGENT_FETCH_ABORTED', context: { callerSignalAborted: true, timeoutReached: false, responseReceived: false } } });
  });
});

describe('the body sent to the reasoning server', () => {
  it('is assembled only from fields the privacy gateway already cleared', () => {
    const body = toAgentBody({ ...request, sanitizedImage: { mimeType: 'image/png', base64: 'AAAA', width: 480, height: 720 } });
    expect(Object.keys(body).sort()).toEqual(['action_history', 'instruction', 'page_info', 'problem_context', 'ss']);
    // A fresh run has performed nothing yet: the field is present but empty.
    expect(body.action_history).toEqual([]);
    expect(body.instruction).toBe('Register for the workshop');
    expect(body.ss).toBe('AAAA');
    // Every addressable name in the description is an opaque observation id.
    for (const id of body.page_info.match(/id=\S+/g) ?? []) expect(request.elements.some(element => id === `id=${element.id}`)).toBe(true);
    expect(body.page_info).toContain('value_1 fills obs_1_e1');
    expect(body.problem_context).toContain('Never invent an id');
  });
  it('includes a safe execution report and asks for the next step', () => {
    const body = toAgentBody({ ...request }, {
      observationId: 'obs_previous', actionType: 'click', target: 'obs_previous_e1', status: 'executed',
    });
    expect(body.problem_context).toContain('Execution report from the previous observation');
    expect(body.problem_context).toContain('"actionType":"click"');
    expect(body.problem_context).toContain('"target":"obs_previous_e1"');
    // The report tells the server the action landed and the page was observed
    // again: planning continues from the new page_info. It must not instruct
    // the server to stop (the old halt that ended every run after one action).
    expect(body.problem_context).toContain('Plan the next step from the current page_info');
    expect(body.problem_context).not.toContain('do not execute another action');
    expect(body.problem_context).not.toContain('student@example.com');
  });
  it('describes an empty view without pretending controls exist', () => {
    expect(describePage({ ...request, elements: [], valueRefs: [] })).toContain('no interactive element');
  });
  it('places each element in the attached screenshot, without inventing anything', () => {
    const withBoxes = { ...request, elements: request.elements.map((element, index) => ({ ...element,
      bounds: { x: 8 + index * 10, y: 8 + index * 10, width: 100, height: 24 } })),
      sanitizedImage: { mimeType: 'image/png' as const, base64: 'AAAA', width: 480, height: 720 } };
    const body = toAgentBody(withBoxes);
    // The redacted-label control is locatable by position in image pixels…
    expect(body.page_info).toContain('id=obs_1_e1 role=textbox label="Full name" box=[6,6,104,28] in a 480x720 screenshot');
    expect(body.page_info).toContain('A redacted screenshot of this same view is attached (480x720 px)');
    // …and every addressable id is still one the payload exported.
    for (const id of body.page_info.match(/id=\S+/g) ?? []) expect(withBoxes.elements.some(element => id === `id=${element.id}`)).toBe(true);
    expect(body.page_info).not.toContain('xpath');
  });
  it('says which listed controls lie outside a viewport screenshot', () => {
    const body = toAgentBody({ ...request, elements: [{ ...request.elements[0], bounds: { x: 8, y: 8, width: 100, height: 24 } }, request.elements[3]],
      sanitizedImage: { mimeType: 'image/png' as const, base64: 'AAAA', width: 480, height: 720 } });
    expect(body.page_info).toContain('id=obs_1_e4 role=button label="Submit" (outside the screenshot)');
    expect(body.problem_context).toContain('navigate');
  });
  it('adds no box when no screenshot is attached', () => {
    const body = toAgentBody({ ...request });
    expect(body.page_info).not.toContain('box=');
    expect(body.page_info).toContain('No screenshot is attached.');
  });
  it('accepts the wrapped reply the server sends and a flat one', () => {
    const answer = { thought: 'ok', output: [] };
    expect(unwrapReply({ response: answer })).toEqual(answer);
    expect(unwrapReply({ response: JSON.stringify(answer) })).toEqual(answer);
    expect(unwrapReply(answer)).toEqual(answer);
  });
});

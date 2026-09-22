import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { requestStep, categoryOf, LIMITS } from '../../src/agent/transport';
import { abortWith, abortReasonOf, newRunId } from '../../src/agent/diagnostics';
import type { StepRequest, TransportStage } from '../../src/contracts';

// One redacted payload, the shape the privacy gateway produces.
const request: StepRequest = { protocolVersion: 1, requestId: 'request_1', taskId: 'task_1', observationId: 'obs_1',
  sanitizedInstruction: 'Open the profile page',
  elements: [{ id: 'obs_1_e1', role: 'link', description: 'Profile' }, { id: 'obs_1_e2', role: 'button', description: 'Submit' }],
  valueRefs: [] };
const endpoint = 'https://agent.example.test/step';
const reply = (output: unknown[], extra: object = {}) => ({ response: { thought: 'Clicking profile.', output, ...extra } });
const json = (body: unknown, status = 200) => vi.fn().mockResolvedValue(
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const named = (name: string, message = 'boom') => { const error = new Error(message); error.name = name; return error; };
// Collects the staged event stream the panel and the console both read.
const run = async (fetchImpl: unknown, extra: Partial<Parameters<typeof requestStep>[0]> = {}) => {
  const stages: TransportStage[] = [];
  const result = await requestStep({ endpoint, request, signal: new AbortController().signal, runId: 'run_test_0001',
    fetchImpl: fetchImpl as typeof fetch, onEvent: event => stages.push(event.stage), ...extra });
  return { result, stages };
};

let quietInfo: ReturnType<typeof vi.spyOn>, quietError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  quietInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
  quietError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { quietInfo.mockRestore(); quietError.mockRestore(); });

describe('transport diagnostics', () => {
  it('reports every stage in order for a successful request', async () => {
    const { result, stages } = await run(json(reply([{ action: 'click', id: 'obs_1_e1' }])));
    expect(result.ok).toBe(true);
    expect(stages).toEqual(['request_initialized', 'payload_serialized', 'fetch_started', 'response_received',
      'response_body_read_started', 'response_body_received', 'json_parse_started', 'json_parsed', 'reply_unwrapped',
      'response_validated', 'plan_validated', 'transport_completed']);
  });
  it('sends the run id as a request header so backend logs can be correlated', async () => {
    const fetchImpl = json(reply([{ action: 'finish' }]));
    await run(fetchImpl);
    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-Request-ID']).toBe('run_test_0001');
  });
  it('mints a run id when a request is made outside a run', async () => {
    const { result } = await run(json('nonsense'), { runId: undefined });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.runId).toMatch(/^run_\d{8}_\d{6}_[0-9a-f]{4}$/);
  });

  it.each([
    ['an HTTP 404', json('missing', 404), 'AGENT_HTTP_ERROR', 'SERVER_REFUSED', 'response_received'],
    ['an HTTP 502', json('bad gateway', 502), 'AGENT_HTTP_ERROR', 'SERVER_REFUSED', 'response_received'],
    ['an empty body', json('', 200), 'AGENT_RESPONSE_EMPTY', 'MALFORMED_RESPONSE', 'response_body_received'],
    ['invalid JSON', json('<html>gateway</html>'), 'AGENT_JSON_PARSE_FAILED', 'MALFORMED_RESPONSE', 'json_parse_started'],
    ['a reply that is not an object', json('"just a string"'), 'AGENT_MALFORMED_RESPONSE', 'MALFORMED_RESPONSE', 'json_parsed'],
    ['a schema failure', json({ response: { thought: 'hi' } }), 'AGENT_RESPONSE_SCHEMA_INVALID', 'MALFORMED_RESPONSE', 'response_validated'],
    ['a reply for another request', json(reply([{ action: 'finish' }], { requestId: 'request_9' })), 'AGENT_PLAN_VALIDATION_FAILED', 'WRONG_REQUEST', 'plan_validated'],
    ['a network failure', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), 'AGENT_FETCH_NETWORK_ERROR', 'SERVER_UNREACHABLE', 'fetch_started'],
    ['an unknown failure', vi.fn().mockRejectedValue(named('WeirdError')), 'AGENT_UNKNOWN_ERROR', 'SERVER_UNREACHABLE', 'fetch_started'],
  ])('classifies %s', async (_label, fetchImpl, code, reason, stage) => {
    const { result } = await run(fetchImpl);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
    expect(result.reason).toBe(reason);
    expect(result.error.stage).toBe(stage);
    expect(result.error.runId).toBe('run_test_0001');
    expect(result.error.timestamp).toMatch(/^\d{4}-/);
  });

  it('refuses a plain http endpoint before anything is serialized or sent', async () => {
    const fetchImpl = json(reply([{ action: 'finish' }]));
    const { result, stages } = await run(fetchImpl, { endpoint: 'http://tracker.example.test/step' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AGENT_ENDPOINT_REJECTED');
    expect(result.reason).toBe('ENDPOINT_REJECTED');
    expect(stages).toEqual(['request_initialized', 'request_initialized']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('separates a caller cancellation from a timeout, and names who cancelled', async () => {
    const caller = new AbortController();
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(named('AbortError', 'The user aborted a request.')));
    }));
    const pending = requestStep({ endpoint, request, signal: caller.signal, runId: 'run_test_0002',
      timeoutMs: 60_000, fetchImpl: fetchImpl as unknown as typeof fetch });
    abortWith(caller, 'task_restart', 'a newer task replaced the active run');
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AGENT_FETCH_ABORTED');
    expect(result.error.stage).toBe('fetch_started');
    expect(result.error.context).toMatchObject({
      abortSource: 'task_restart', abortReason: 'a newer task replaced the active run',
      callerSignalAborted: true, internalSignalAborted: true, timeoutReached: false, responseReceived: false,
    });
    expect(result.error.originalError).toBe('AbortError: The user aborted a request.');
  });

  it('reports its own timeout as a timeout, not as a cancellation', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(named('AbortError', 'signal is aborted without reason')));
      }));
      const pending = requestStep({ endpoint, request, signal: new AbortController().signal, runId: 'run_test_0003',
        timeoutMs: 1_000, fetchImpl: fetchImpl as unknown as typeof fetch });
      await vi.advanceTimersByTimeAsync(1_100);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('AGENT_FETCH_TIMEOUT');
      expect(result.error.context).toMatchObject({ timeoutReached: true, timeoutMs: 1_000, callerSignalAborted: false, abortSource: 'timeout' });
    } finally { vi.useRealTimers(); }
  });

  it('separates a body that cannot be read from a request that never connected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', type: 'basic', redirected: false, url: endpoint,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      text: () => Promise.reject(new TypeError('network error')),
    });
    const { result } = await run(fetchImpl);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AGENT_RESPONSE_READ_FAILED');
    expect(result.error.stage).toBe('response_body_read_started');
    expect(result.error.context).toMatchObject({ responseReceived: true, httpStatus: 200 });
  });

  it('records redirect evidence when the endpoint answers from another url', async () => {
    // `redirected` is a prototype getter, so the stub stands in for a response
    // the tunnel produced after following one.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', type: 'basic', redirected: true, url: 'https://agent.example.test/step/v2',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      text: () => Promise.resolve(JSON.stringify(reply([{ action: 'finish' }]))),
    });
    const events: Array<Record<string, unknown> | undefined> = [];
    await requestStep({ endpoint, request, signal: new AbortController().signal, fetchImpl: fetchImpl as typeof fetch,
      onEvent: event => { if (event.stage === 'response_received') events.push(event.detail); } });
    expect(events[0]).toMatchObject({ requestedUrl: endpoint, redirected: true,
      responseUrl: 'https://agent.example.test/step/v2', urlChanged: true });
  });

  it('refuses an oversized reply on the declared length and on the delivered bytes', async () => {
    const declared = vi.fn().mockResolvedValue(new Response('{}', { status: 200,
      headers: { 'Content-Length': String(LIMITS.responseBytes + 1) } }));
    expect((await run(declared)).result).toMatchObject({ reason: 'RESPONSE_TOO_LARGE', error: { code: 'AGENT_RESPONSE_TOO_LARGE' } });
    const delivered = json(' '.repeat(LIMITS.responseBytes + 1));
    expect((await run(delivered)).result).toMatchObject({ reason: 'RESPONSE_TOO_LARGE' });
  });

  it('keeps diagnostics free of payload content', async () => {
    const secret = 'Mira Verma mira@example.test';
    const withSecret: StepRequest = { ...request, sanitizedInstruction: secret };
    const events: unknown[] = [];
    await requestStep({ endpoint, request: withSecret, signal: new AbortController().signal,
      fetchImpl: json(reply([{ action: 'finish' }])) as unknown as typeof fetch, onEvent: event => events.push(event) });
    expect(JSON.stringify(events)).not.toContain('mira@example.test');
    expect(JSON.stringify(events)).not.toContain('Mira');
  });

  it('maps every precise code onto a coarse category the older panel code reads', () => {
    expect(categoryOf('AGENT_FETCH_ABORTED')).toBe('SERVER_UNREACHABLE');
    expect(categoryOf('AGENT_HTTP_ERROR')).toBe('SERVER_REFUSED');
    expect(categoryOf('AGENT_JSON_PARSE_FAILED')).toBe('MALFORMED_RESPONSE');
  });
  it('carries an abort reason on the signal it aborts', () => {
    const controller = new AbortController();
    abortWith(controller, 'pagehide', 'the panel document was hidden', { runId: 'run_x' });
    expect(abortReasonOf(controller.signal)).toMatchObject({ source: 'pagehide', reason: 'the panel document was hidden', runId: 'run_x' });
    expect(abortReasonOf(new AbortController().signal)).toBeUndefined();
  });
  it('mints sortable run ids', () => {
    expect(newRunId(new Date('2026-09-18T14:22:33Z'))).toMatch(/^run_20260918_142233_[0-9a-f]{4}$/);
  });
});

import { AbortReasonSchema, type StepRequest, type TransportError, type TransportErrorCode, type TransportStage } from '../contracts';
import { planActions, type PlanSuccess } from './protocol';
import { toAgentBody, unwrapReply, type ExecutionReport } from './wire';
import type { ActionHistoryEntry } from './lifecycle';
import { AGENT_ENDPOINT, endpointAllowed } from '../config';
import { abortReasonOf, abortWith, logStage, newRunId, transportError,
  type StageEvent, type StageListener } from './diagnostics';

// The endpoint is editable in the panel, but its default, the manifest's host
// permission and the panel's connect-src all come from `src/config.ts` now, and
// the build refuses to package them out of step.
export { AGENT_BASE_URL, AGENT_ENDPOINT } from '../config';
export const DEFAULT_ENDPOINT = AGENT_ENDPOINT;
export interface TransportInput {
  endpoint: string;
  request: StepRequest;
  signal: AbortSignal;
  timeoutMs?: number;
  // The id of the run this request belongs to. Generated here when a request is
  // made outside a run, so every request is traceable either way.
  runId?: string;
  fetchImpl?: typeof fetch;
    executionReport?: ExecutionReport;
  // What the executor actually did in earlier rounds of this task, recorded at
  // the executor boundary and sent with every planning request.
  actionHistory?: ActionHistoryEntry[];
  // Every stage, in order, including the failing one. It cannot change the
  // request or the verdict.
  onEvent?: StageListener;
}
// The coarse category older code and the run log still read, kept so nothing
// downstream breaks, and the precise failure beside it. Every reason the
// function can actually return is listed here — including MALFORMED_RESPONSE
// and WRONG_REQUEST, which arrive from `planActions` and which the union used
// to omit — and there is exactly one failure shape, so no caller has to handle
// two spellings of the same thing.
export type TransportReason = 'ENDPOINT_REJECTED' | 'SERVER_UNREACHABLE' | 'SERVER_REFUSED' | 'RESPONSE_TOO_LARGE'
  | 'MALFORMED_RESPONSE' | 'WRONG_REQUEST';
export interface TransportFailure { ok: false; reason: TransportReason; error: TransportError }
export type TransportResult = PlanSuccess | TransportFailure;
// A hosted model answers in roughly 15 s for a small page; the ceiling leaves
// room for a long one without letting a stalled tunnel hold the panel forever.
export const LIMITS = Object.freeze({ responseBytes: 200_000, timeoutMs: 240_000, bodyPreview: 200 });

export { endpointAllowed } from '../config';

// Which coarse category a precise code belongs to. Callers that only branch on
// the category keep working; anything that wants the truth reads `error`.
const categories: Record<TransportErrorCode, TransportReason> = {
  AGENT_ENDPOINT_REJECTED: 'ENDPOINT_REJECTED',
  AGENT_FETCH_ABORTED: 'SERVER_UNREACHABLE',
  AGENT_FETCH_TIMEOUT: 'SERVER_UNREACHABLE',
  AGENT_FETCH_NETWORK_ERROR: 'SERVER_UNREACHABLE',
  AGENT_REDIRECT_BLOCKED: 'SERVER_UNREACHABLE',
  AGENT_UNKNOWN_ERROR: 'SERVER_UNREACHABLE',
  AGENT_HTTP_ERROR: 'SERVER_REFUSED',
  AGENT_RESPONSE_READ_FAILED: 'SERVER_UNREACHABLE',
  AGENT_RESPONSE_EMPTY: 'MALFORMED_RESPONSE',
  AGENT_RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  AGENT_JSON_PARSE_FAILED: 'MALFORMED_RESPONSE',
  AGENT_MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  AGENT_RESPONSE_SCHEMA_INVALID: 'MALFORMED_RESPONSE',
  AGENT_PLAN_VALIDATION_FAILED: 'WRONG_REQUEST',
};
export const categoryOf = (code: TransportErrorCode): TransportReason => categories[code] ?? 'SERVER_UNREACHABLE';

export async function requestStep(input: TransportInput): Promise<TransportResult> {
  const { endpoint, request, signal } = input;
  const runId = input.runId ?? newRunId();
  const timeoutMs = input.timeoutMs ?? LIMITS.timeoutMs;
  const started = Date.now();
  const timeout = new AbortController();
  let stage: TransportStage = 'request_initialized';
  let timeoutReached = false;
  let responseReceived = false;
  let httpStatus: number | undefined;

  const emit = (next: TransportStage, detail?: Record<string, unknown>, error?: TransportError) => {
    stage = next;
    const event: StageEvent = {
      runId, stage: next, at: new Date().toISOString(), elapsedMs: Date.now() - started,
      endpoint, method: 'POST', callerAborted: signal.aborted, internalAborted: timeout.signal.aborted,
      ...(detail ? { detail } : {}), ...(error ? { error } : {}),
    };
    logStage(event);
    input.onEvent?.(event);
  };
  // Every failure leaves through here, so no path can quietly collapse into a
  // category again.
  const fail = (code: TransportErrorCode, message: string, extra: {
    cause?: string; error?: unknown; context?: Record<string, unknown>;
  } = {}): TransportFailure => {
    const error = transportError({
      code, stage, message, runId, cause: extra.cause, error: extra.error,
      context: {
        elapsedMs: Date.now() - started, endpoint, method: 'POST',
        callerSignalAborted: signal.aborted, internalSignalAborted: timeout.signal.aborted,
        timeoutReached, timeoutMs, responseReceived,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(abortReasonOf(signal) ? { abortSource: abortReasonOf(signal)!.source, abortReason: abortReasonOf(signal)!.reason } : {}),
        ...extra.context,
      },
    });
    emit(stage, undefined, error);
    return { ok: false, reason: categoryOf(code), error };
  };

  emit('request_initialized', { elements: request.elements.length, valueRefs: request.valueRefs.length,
    imageAttached: !!request.sanitizedImage, requestId: request.requestId, observationId: request.observationId });
  if (!endpointAllowed(endpoint)) {
    return fail('AGENT_ENDPOINT_REJECTED', 'Only https, or http on localhost, may receive the payload.',
      { cause: 'endpoint scheme rejected before any bytes were sent' });
  }

  const call = input.fetchImpl ?? fetch;
  let body: string;
  try {
    body = JSON.stringify(toAgentBody(request, input.executionReport, input.actionHistory));
  } catch (error) {
    return fail('AGENT_UNKNOWN_ERROR', 'The redacted payload could not be serialized.', { error, cause: 'JSON.stringify threw' });
  }
  // Sizes and counts only: the payload itself is never logged, redacted or not.
  emit('payload_serialized', { requestBytes: body.length, imageBytes: request.sanitizedImage?.base64.length ?? 0 });

  // One controller owns this request. It aborts for exactly two reasons, and
  // both are recorded on the signal before the abort so the catch below can
  // tell them apart instead of guessing.
  const onCallerAbort = () => {
    const caller = abortReasonOf(signal);
    abortWith(timeout, caller?.source ?? 'caller_signal',
      caller?.reason ?? 'the caller’s signal aborted without a recorded reason', { runId, stage, scope: 'transport' });
  };
  signal.addEventListener('abort', onCallerAbort, { once: true });
  if (signal.aborted) onCallerAbort();
  const timer = setTimeout(() => {
    timeoutReached = true;
    abortWith(timeout, 'timeout', `no reply within ${timeoutMs} ms`, { runId, stage, scope: 'transport' });
  }, timeoutMs);

  try {
    emit('fetch_started', { timeoutMs, requestBytes: body.length });
    let response: Response;
    try {
      response = await call(endpoint, {
        method: 'POST', signal: timeout.signal,
        // No cookies, no cached reply, no redirect to an origin the user never approved.
        credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Request-ID': runId },
        body,
      });
    } catch (error) {
      return classifyFetchFailure(error);
    }
    responseReceived = true;
    httpStatus = response.status;
    // Redirect diagnostics: with `redirect: "error"` a followed redirect never
    // reaches here, but a same-URL check still shows whether the tunnel moved
    // the request, and `type` shows whether the body is readable at all.
    emit('response_received', {
      status: response.status, statusText: response.statusText.slice(0, 80), responseType: response.type,
      redirected: response.redirected, requestedUrl: endpoint, responseUrl: response.url,
      urlChanged: response.url !== endpoint,
      contentType: response.headers.get('content-type')?.slice(0, 80) ?? null,
      contentLength: response.headers.get('content-length') ?? null,
    });
    if (!response.ok) {
      return fail('AGENT_HTTP_ERROR', `The agent answered ${response.status} ${response.statusText}.`.trim(),
        { cause: `HTTP ${response.status}`, context: { statusText: response.statusText.slice(0, 80) } });
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > LIMITS.responseBytes) {
      return fail('AGENT_RESPONSE_TOO_LARGE', `The reply declared ${declared} bytes, over the ${LIMITS.responseBytes} byte limit.`,
        { cause: 'content-length over limit', context: { declaredBytes: declared, limitBytes: LIMITS.responseBytes } });
    }

    emit('response_body_read_started', { declaredBytes: declared || null });
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The status line arrived and the body did not: a dropped connection, a
      // cancelled stream, or an abort during the read.
      return fail('AGENT_RESPONSE_READ_FAILED', 'The reply body could not be read to the end.',
        { error, cause: timeout.signal.aborted ? 'aborted while reading the body' : 'the connection ended mid-body' });
    }
    // A chunked reply has no declared length, so check the delivered bytes too.
    if (text.length > LIMITS.responseBytes) {
      return fail('AGENT_RESPONSE_TOO_LARGE', `The reply delivered ${text.length} bytes, over the ${LIMITS.responseBytes} byte limit.`,
        { cause: 'delivered body over limit', context: { receivedBytes: text.length, limitBytes: LIMITS.responseBytes } });
    }
    emit('response_body_received', { receivedBytes: text.length });
    if (!text.trim()) {
      return fail('AGENT_RESPONSE_EMPTY', 'The agent answered with an empty body.',
        { cause: 'zero-length body', context: { receivedBytes: text.length } });
    }

    emit('json_parse_started', { receivedBytes: text.length });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // The reply came from a server that only ever received redacted data, so a
      // short preview cannot expose page content; it is what identifies an HTML
      // error page or a truncated stream.
      return fail('AGENT_JSON_PARSE_FAILED', 'The reply is not valid JSON.',
        { error, cause: 'JSON.parse threw', context: { receivedBytes: text.length, bodyPreview: preview(text) } });
    }
    emit('json_parsed', { topLevelKeys: keysOf(parsed) });

    const unwrapped = unwrapReply(parsed);
    if (unwrapped === null || typeof unwrapped !== 'object') {
      return fail('AGENT_MALFORMED_RESPONSE', 'The reply is JSON but carries no response object.',
        { cause: `reply resolved to ${unwrapped === null ? 'null' : typeof unwrapped}`,
          context: { topLevelKeys: keysOf(parsed), unwrappedType: unwrapped === null ? 'null' : typeof unwrapped } });
    }
    emit('reply_unwrapped', { wrapped: parsed !== unwrapped, replyKeys: keysOf(unwrapped) });

    const plan = planActions(unwrapped, request, runId);
    if (!plan.ok) {
      // planActions already classified this as a schema or plan failure; the
      // transport only adds where and when it happened.
      const error: TransportError = { ...plan.error, stage: plan.error.stage,
        context: { ...plan.error.context, elapsedMs: Date.now() - started, httpStatus, responseReceived: true } };
      stage = error.stage;
      emit(stage, undefined, error);
      return { ok: false, reason: plan.reason, error };
    }
    emit('response_validated', { steps: plan.steps.length, rejected: plan.rejected.length });
    emit('plan_validated', { runnable: plan.steps.length > 0, rejected: plan.rejected.length });
    emit('transport_completed', { totalMs: Date.now() - started, steps: plan.steps.length });
    return plan;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);
  }

  // The classification the old single catch destroyed. Every branch keeps the
  // original exception, and the fallback says so rather than inventing a cause.
  function classifyFetchFailure(error: unknown): TransportFailure {
    const caller = abortReasonOf(signal);
    const internal = abortReasonOf(timeout.signal);
    // A controller aborted with a reason rejects the fetch with that reason
    // object rather than an AbortError, so read it as the cancellation it is.
    const thrownAbort = AbortReasonSchema.safeParse(error);
    const name = thrownAbort.success ? 'AbortError' : error instanceof Error ? error.name : typeof error;
    const message = thrownAbort.success ? `${thrownAbort.data.source}: ${thrownAbort.data.reason}`
      : error instanceof Error ? error.message : String(error);
    const context = {
      errorName: name, errorMessage: message.slice(0, 200), errorType: error?.constructor?.name ?? typeof error,
      abortSource: internal?.source ?? caller?.source ?? (timeoutReached ? 'timeout' : 'unknown'),
      abortReason: internal?.reason ?? caller?.reason,
    };
    if (name === 'AbortError' || timeout.signal.aborted) {
      if (timeoutReached && !signal.aborted) {
        return fail('AGENT_FETCH_TIMEOUT', `No reply within ${timeoutMs} ms, so the request was abandoned.`,
          { error, cause: 'the transport’s own timeout fired', context });
      }
      return fail('AGENT_FETCH_ABORTED', 'The request was cancelled before the agent answered.',
        { error, cause: caller ? `${caller.source}: ${caller.reason}` : 'the caller aborted without a recorded reason', context });
    }
    if (name === 'TypeError') {
      // Chrome reports a blocked redirect, a DNS failure, a TLS failure and a
      // dropped connection identically, as "Failed to fetch". Say so instead of
      // picking one.
      return fail('AGENT_FETCH_NETWORK_ERROR', 'The request never completed: the browser reports only a generic network failure.',
        { error, cause: 'fetch rejected with TypeError; the browser does not expose the precise network reason',
          context: { ...context, indistinguishableFrom: ['dns', 'tls', 'connection_refused', 'tunnel_closed', 'blocked_redirect'] } });
    }
    return fail('AGENT_UNKNOWN_ERROR', 'The request failed for a reason the browser did not describe.', { error, context });
  }
}

const preview = (text: string) => text.slice(0, LIMITS.bodyPreview).replace(/\s+/g, ' ');
const keysOf = (value: unknown) => value && typeof value === 'object' ? Object.keys(value).slice(0, 12) : [];

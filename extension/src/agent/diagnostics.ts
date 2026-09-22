import { AbortReasonSchema, type AbortReason, type AbortSource, type ExtensionError,
  type TransportError, type TransportErrorCode, type TransportStage } from '../contracts';

// Everything in this module is structural: identifiers, stages, sizes, counts,
// states and timings. Page text, OCR output, instructions, screenshots and the
// payload itself never pass through it — diagnostics must not become the hole
// in a privacy-preserving pipeline.

// A run is one user instruction from the moment it is submitted. The same id
// travels through the panel, the transport, the backend request header and the
// run log, so one failure can be followed across all of them.
export function newRunId(now = new Date()): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}_${iso.slice(11, 19).replace(/:/g, '')}`;
  const random = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `run_${stamp}_${random}`;
}

export interface StageEvent {
  runId: string;
  stage: TransportStage;
  at: string;
  elapsedMs: number;
  endpoint: string;
  method: string;
  callerAborted: boolean;
  internalAborted: boolean;
  detail?: Record<string, unknown>;
  error?: TransportError;
}
export type StageListener = (event: StageEvent) => void;

const line = (event: StageEvent) => `[AGENT][${event.runId}] ${event.stage.replace(/_/g, ' ')}`;
// One console line per stage, plus the structured record for anyone reading the
// panel's run log. Errors print the whole classification, because that is the
// point of the exercise.
export function logStage(event: StageEvent) {
  if (event.error) {
    console.error(`[AGENT][${event.runId}][ERROR]\ncode=${event.error.code}\nstage=${event.error.stage}\n` +
      `${Object.entries({ ...event.error.context, originalError: event.error.originalError })
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n')}`);
    return;
  }
  console.info(`${line(event)}${event.detail ? ` ${Object.entries(event.detail)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' ')}` : ''}`);
}

// ---------------------------------------------------------------------------
// Aborts
//
// An AbortError only says that something cancelled. These helpers attach who
// and why to the signal itself, so the transport can report a task restart as a
// task restart instead of an unreachable server.
export function abortWith(controller: AbortController, source: AbortSource, reason: string,
  extra: { runId?: string; stage?: string; scope?: string } = {}) {
  if (controller.signal.aborted) return;
  const { scope, ...rest } = extra;
  const detail: AbortReason = { source, reason, at: new Date().toISOString(), ...rest };
  console.info(`[AGENT][${detail.runId ?? 'no-run'}][ABORT]\nscope=${scope ?? 'unnamed'}\nsource=${source}\nreason="${reason}"` +
    `${detail.stage ? `\nstage=${detail.stage}` : ''}`);
  // Chrome 98+ carries the reason on the signal; the manifest requires 116.
  controller.abort(detail);
}
export function abortReasonOf(signal?: AbortSignal | null): AbortReason | undefined {
  if (!signal?.aborted) return undefined;
  const parsed = AbortReasonSchema.safeParse((signal as { reason?: unknown }).reason);
  return parsed.success ? parsed.data : undefined;
}
export const abortSourceOf = (signal?: AbortSignal | null): AbortSource | undefined => abortReasonOf(signal)?.source;

// ---------------------------------------------------------------------------
// Errors

export interface ErrorInput {
  code: TransportErrorCode;
  stage: TransportStage;
  message: string;
  cause?: string;
  error?: unknown;
  runId?: string;
  context?: Record<string, unknown>;
}
// "Name: message" only. A stack trace is noise in a panel and can carry file
// paths; the console keeps the original object for anyone who wants more.
export function describeError(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  const aborted = AbortReasonSchema.safeParse(error);
  if (aborted.success) return `AbortError: ${aborted.data.source}: ${aborted.data.reason}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  if (typeof error === 'object') { try { return JSON.stringify(error).slice(0, 500); } catch { return 'unserializable error object'; } }
  return String(error).slice(0, 500);
}
export function transportError(input: ErrorInput): TransportError {
  return {
    code: input.code, stage: input.stage, message: input.message,
    ...(input.cause ? { cause: input.cause } : {}),
    ...(describeError(input.error) ? { originalError: describeError(input.error) } : {}),
    ...(input.context ? { context: input.context } : {}),
    timestamp: new Date().toISOString(),
    ...(input.runId ? { runId: input.runId } : {}),
  };
}

// What a person reading the panel should see. Deliberately plain: the code and
// the developer details carry the precision.
const explanations: Record<TransportErrorCode, string> = {
  AGENT_ENDPOINT_REJECTED: 'The endpoint is not an https address, so the payload was never sent.',
  AGENT_FETCH_ABORTED: 'The request was cancelled before the agent answered.',
  AGENT_FETCH_TIMEOUT: 'The agent did not answer within the time limit.',
  AGENT_FETCH_NETWORK_ERROR: 'The request never reached the agent: DNS, TLS, the tunnel or the connection failed.',
  AGENT_REDIRECT_BLOCKED: 'The endpoint answered with a redirect, which is refused rather than followed.',
  AGENT_HTTP_ERROR: 'The agent answered with an error status.',
  AGENT_RESPONSE_READ_FAILED: 'The agent answered, but the connection broke while its reply was being read.',
  AGENT_RESPONSE_EMPTY: 'The agent answered with an empty body.',
  AGENT_RESPONSE_TOO_LARGE: 'The reply exceeded the size this panel accepts.',
  AGENT_JSON_PARSE_FAILED: 'The reply arrived but is not valid JSON.',
  AGENT_MALFORMED_RESPONSE: 'The reply is JSON, but not in the shape this panel accepts.',
  AGENT_RESPONSE_SCHEMA_INVALID: 'The reply did not match the agent response schema.',
  AGENT_PLAN_VALIDATION_FAILED: 'The reply was understood but described no step this observation permits.',
  AGENT_UNKNOWN_ERROR: 'The request failed for a reason the browser did not describe.',
};
export const explain = (code: string): string => explanations[code as TransportErrorCode] ?? 'The request failed.';

// The short title above the explanation, for the panel.
const titles: Record<TransportErrorCode, string> = {
  AGENT_ENDPOINT_REJECTED: 'Endpoint refused',
  AGENT_FETCH_ABORTED: 'Request cancelled',
  AGENT_FETCH_TIMEOUT: 'Agent timed out',
  AGENT_FETCH_NETWORK_ERROR: 'Could not reach the agent',
  AGENT_REDIRECT_BLOCKED: 'Redirect blocked',
  AGENT_HTTP_ERROR: 'Agent returned an error',
  AGENT_RESPONSE_READ_FAILED: 'Reply could not be read',
  AGENT_RESPONSE_EMPTY: 'Empty reply',
  AGENT_RESPONSE_TOO_LARGE: 'Reply too large',
  AGENT_JSON_PARSE_FAILED: 'Reply was not JSON',
  AGENT_MALFORMED_RESPONSE: 'Unexpected reply shape',
  AGENT_RESPONSE_SCHEMA_INVALID: 'Reply failed validation',
  AGENT_PLAN_VALIDATION_FAILED: 'No usable step',
  AGENT_UNKNOWN_ERROR: 'Request failed',
};
export const titleFor = (code: string): string => titles[code as TransportErrorCode] ?? 'Request failed';

// The one-line summary used for the run log and the halt notice.
export function summarize(error: ExtensionError): string {
  const context = error.context ?? {};
  const extras = ['abortSource', 'httpStatus', 'elapsedMs'].filter(key => context[key] !== undefined)
    .map(key => `${key}=${String(context[key])}`);
  return `${error.code} at ${error.stage}${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

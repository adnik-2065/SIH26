import type { StepRequest } from '../contracts';
import { planActions, type Plan } from './protocol';
import { toAgentBody, unwrapReply } from './wire';

// The endpoint is editable in the panel. This default is the project's own
// reasoning server; it is also the only remote origin the manifest permits, so
// changing one without the other fails closed.
export const DEFAULT_ENDPOINT = 'https://awareness-psp-estimates-rising.trycloudflare.com/agent';
export interface TransportInput { endpoint: string; request: StepRequest; signal: AbortSignal; timeoutMs?: number;
  fetchImpl?: typeof fetch;
  // Observes the exact bytes exchanged, for the panel's run log. It cannot
  // change the request or the verdict.
  onTrace?: (trace: { sent: unknown; status?: number; body?: string }) => void }
export type TransportResult = Plan | { ok: false; reason: 'ENDPOINT_REJECTED' | 'SERVER_UNREACHABLE' | 'SERVER_REFUSED' | 'RESPONSE_TOO_LARGE' };
// A hosted model answers in roughly 15 s for a small page; the ceiling leaves
// room for a long one without letting a stalled tunnel hold the panel forever.
export const LIMITS = Object.freeze({ responseBytes: 200_000, timeoutMs: 120_000 });

// Only an https origin, or explicit loopback for local development. A plain
// http host would put the sanitized payload on the wire in clear text.
export function endpointAllowed(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export async function requestStep(input: TransportInput): Promise<TransportResult> {
  const { endpoint, request, signal } = input;
  if (!endpointAllowed(endpoint)) return { ok: false, reason: 'ENDPOINT_REJECTED' };
  const call = input.fetchImpl ?? fetch;
  const sent = toAgentBody(request);
  input.onTrace?.({ sent });
  const timeout = new AbortController();
  const abort = () => timeout.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, input.timeoutMs ?? LIMITS.timeoutMs);
  try {
    const response = await call(endpoint, { method: 'POST', signal: timeout.signal,
      // No cookies, no cached reply, no redirect to an origin the user never approved.
      credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(sent) });
    if (!response.ok) { input.onTrace?.({ sent, status: response.status }); return { ok: false, reason: 'SERVER_REFUSED' }; }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > LIMITS.responseBytes) return { ok: false, reason: 'RESPONSE_TOO_LARGE' };
    const body = await response.text();
    // A chunked reply has no declared length, so check the delivered bytes too.
    if (body.length > LIMITS.responseBytes) return { ok: false, reason: 'RESPONSE_TOO_LARGE' };
    input.onTrace?.({ sent, status: response.status, body });
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return { ok: false, reason: 'MALFORMED_RESPONSE' }; }
    return planActions(unwrapReply(parsed), request);
  } catch { return { ok: false, reason: 'SERVER_UNREACHABLE' }; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

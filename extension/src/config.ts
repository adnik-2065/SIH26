import type { ExtensionError } from './contracts';

// The one place the backend address is written down.
//
// It used to appear in three: the transport default, `host_permissions` and
// `connect-src`. A moved tunnel updated in one of them fails closed at a
// different layer each time — a refused fetch, a CSP violation, or a silent
// permission error — so they are derived from here and checked against the
// shipped manifest at build time and again when the panel opens.
//
// `VITE_AGENT_BASE_URL` overrides the default at build time. The manifest must
// be updated in the same commit; `npm run build` refuses otherwise.
const configured = (import.meta.env?.VITE_AGENT_BASE_URL as string | undefined)?.trim();
export const AGENT_BASE_URL = configured || 'https://hdtv-conditions-fathers-extensions.trycloudflare.com';
export const AGENT_ROUTE = '/agent';
export const AGENT_ENDPOINT = `${AGENT_BASE_URL.replace(/\/+$/, '')}${AGENT_ROUTE}`;

export type EndpointErrorCode = 'BACKEND_ENDPOINT_NOT_CONFIGURED' | 'BACKEND_ENDPOINT_INVALID' | 'BACKEND_ENDPOINT_NOT_ALLOWED';
const endpointError = (code: EndpointErrorCode, message: string, context: Record<string, unknown>, cause?: string): ExtensionError =>
  ({ code, stage: 'AGENT_TRANSPORT', message, context, timestamp: new Date().toISOString(), ...(cause ? { cause } : {}) });

// https, or explicit loopback for local development. A plain http host would
// put the sanitized payload on the wire in clear text.
export function endpointAllowed(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export interface ManifestPermissions { host_permissions?: string[]; csp?: string }
// Does the packaged extension actually permit this origin? Both answers have to
// be yes: MV3 needs the host in `host_permissions`, and the panel's own CSP
// needs it in `connect-src`, or the fetch fails in two different ways.
export function validateAgentEndpoint(endpoint: string | undefined, permissions: ManifestPermissions): ExtensionError | undefined {
  if (!endpoint?.trim()) {
    return endpointError('BACKEND_ENDPOINT_NOT_CONFIGURED', 'No reasoning endpoint is configured.',
      { configured: false }, 'AGENT_BASE_URL is empty');
  }
  if (!endpointAllowed(endpoint)) {
    let protocol = 'unparseable';
    try { protocol = new URL(endpoint).protocol; } catch { /* reported as unparseable */ }
    return endpointError('BACKEND_ENDPOINT_INVALID', 'The reasoning endpoint must be an https URL, or http on localhost.',
      { protocol, endpointLength: endpoint.length }, 'endpoint scheme is not permitted');
  }
  const origin = new URL(endpoint).origin;
  const hosts = permissions.host_permissions ?? [];
  const hostAllowed = hosts.some(pattern => pattern.startsWith(`${origin}/`) || pattern === origin || pattern === `${origin}/*`);
  const cspAllowed = (permissions.csp ?? '').includes(origin);
  if (!hostAllowed || !cspAllowed) {
    return endpointError('BACKEND_ENDPOINT_NOT_ALLOWED',
      'The packaged extension does not permit this endpoint, so the request would fail closed.',
      { origin, hostPermission: hostAllowed, connectSrc: cspAllowed, hostPermissions: hosts.length },
      hostAllowed ? 'origin missing from connect-src' : 'origin missing from host_permissions');
  }
  return undefined;
}

// The manifest as the running extension sees it. Kept separate so the checker
// itself stays pure and testable.
export function runtimePermissions(): ManifestPermissions {
  const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
    host_permissions?: string[]; content_security_policy?: { extension_pages?: string } };
  return { host_permissions: manifest.host_permissions, csp: manifest.content_security_policy?.extension_pages };
}

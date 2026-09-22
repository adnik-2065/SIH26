import { describe, expect, it } from 'vitest';
import { AGENT_ENDPOINT, AGENT_BASE_URL, validateAgentEndpoint } from '../../src/config';

const permitted = { host_permissions: [`${AGENT_BASE_URL}/*`], csp: `connect-src 'self' ${AGENT_BASE_URL}` };

describe('the one backend configuration', () => {
  it('derives the agent route from the base url', () => {
    expect(AGENT_ENDPOINT).toBe(`${AGENT_BASE_URL}/agent`);
    expect(AGENT_ENDPOINT.startsWith('https://')).toBe(true);
  });
  it('accepts the configured endpoint when the manifest permits it', () => {
    expect(validateAgentEndpoint(AGENT_ENDPOINT, permitted)).toBeUndefined();
  });
  it('reports a missing endpoint', () => {
    expect(validateAgentEndpoint('', permitted)).toMatchObject({ code: 'BACKEND_ENDPOINT_NOT_CONFIGURED' });
    expect(validateAgentEndpoint(undefined, permitted)).toMatchObject({ code: 'BACKEND_ENDPOINT_NOT_CONFIGURED' });
  });
  it.each([
    ['plain http', 'http://tracker.example.test/agent'],
    ['a file url', 'file:///tmp/agent'],
    ['not a url at all', 'agent'],
  ])('reports %s as invalid', (_label, endpoint) => {
    expect(validateAgentEndpoint(endpoint, permitted)).toMatchObject({ code: 'BACKEND_ENDPOINT_INVALID', stage: 'AGENT_TRANSPORT' });
  });
  it('keeps http on loopback for local development', () => {
    expect(validateAgentEndpoint('http://127.0.0.1:8000/agent', {
      host_permissions: ['http://127.0.0.1:8000/*'], csp: "connect-src 'self' http://127.0.0.1:8000" })).toBeUndefined();
  });
  it('reports an endpoint the packaged extension does not permit, and which half is missing', () => {
    expect(validateAgentEndpoint('https://elsewhere.example/agent', permitted))
      .toMatchObject({ code: 'BACKEND_ENDPOINT_NOT_ALLOWED', context: { hostPermission: false, connectSrc: false } });
    expect(validateAgentEndpoint(AGENT_ENDPOINT, { host_permissions: [`${AGENT_BASE_URL}/*`], csp: "connect-src 'self'" }))
      .toMatchObject({ code: 'BACKEND_ENDPOINT_NOT_ALLOWED', cause: 'origin missing from connect-src' });
  });
  it('matches the endpoint the packaged manifest actually permits', async () => {
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile('manifest.json', 'utf8'));
    expect(validateAgentEndpoint(AGENT_ENDPOINT, { host_permissions: manifest.host_permissions,
      csp: manifest.content_security_policy?.extension_pages })).toBeUndefined();
  });
});

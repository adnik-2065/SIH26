// Drives the whole round against the real server with no browser and no page:
// a typed instruction goes through PII detection, redaction and the fail-closed
// gateway, the redacted payload is posted, and the reply is translated into the
// steps this observation would actually perform.
// Run with `npm run live-check [endpoint]`. Not part of `npm test`.
import { DEFAULT_ENDPOINT, requestStep } from '../src/agent/transport';
import { executableNow } from '../src/agent/protocol';
import { toAgentBody } from '../src/agent/wire';
import { buildSafeStepRequest } from '../src/privacy';
import { binding, fixture } from './privacy-fixture';

// Deliberately shaped like a real task: words the page also uses ("lms"), words
// no rule can classify ("login"), and a genuine identifier that must not leave.
const INSTRUCTION = 'login into this lms portal and email mira@example.test the result';
const data = fixture();
data.instruction = INSTRUCTION;
data.observation.dom.elements[0].label = 'Sign in to the lms';

const endpoint = process.argv[2] || DEFAULT_ENDPOINT;
// `requestStep` reports one SERVER_UNREACHABLE for every network failure, which
// is right for the panel but useless when diagnosing. Ask the socket directly.
try {
  await fetch(new URL(endpoint).origin, { method: 'GET' });
  console.log(`reachable: ${new URL(endpoint).origin}`);
} catch (error) {
  const code = (error as { cause?: { code?: string } }).cause?.code;
  console.error(`unreachable: ${new URL(endpoint).origin} — ${code ?? String(error)}`);
  if (code === 'ENOTFOUND') console.error('  The hostname does not exist in DNS. The tunnel is closed, or the URL is wrong.');
  if (code === 'ECONNREFUSED') console.error('  DNS resolved but nothing is listening. The tunnel is up; the app behind it is not.');
  process.exit(1);
}

console.log(`--- instruction typed ---\n${INSTRUCTION}\n`);
const redacted = await buildSafeStepRequest({ data, signal: new AbortController().signal, current: () => binding });
if (!redacted.ok) {
  console.error(`--- blocked before sending --- ${redacted.blockedReasons.join(', ')}`);
  process.exit(1);
}
const request = redacted.request;
console.log(`--- instruction sent ---\n${request.sanitizedInstruction}\n`);
// The whole point of the gateway: nothing recognised as personal may survive.
for (const secret of ['mira@example.test', '9876543210', 'Mira']) {
  if (JSON.stringify(request).includes(secret)) { console.error(`LEAK: ${secret} reached the payload`); process.exit(1); }
}
console.log('no raw personal value reached the payload\n');
console.log('--- page_info sent ---\n' + toAgentBody(request).page_info + '\n');
// Print what the server actually said. `requestStep` collapses every bad reply
// into MALFORMED_RESPONSE, which is right for the panel and useless here.
const result = await requestStep({ endpoint, request, signal: new AbortController().signal,
  onTrace: trace => { if (trace.body !== undefined) console.log(`--- raw reply (${trace.status}) ---\n${trace.body}\n`); } });
console.log('--- translated plan ---');
console.log(JSON.stringify(result, null, 2));
if (result.ok) console.log('--- runnable now ---', JSON.stringify(executableNow(result.steps).runnable.map(s => s.action)));

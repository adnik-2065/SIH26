import type { StepRequest } from '../contracts';

// The reasoning server speaks its own shape (`POST /agent`). Everything below is
// derived field by field from the redacted payload: there is no path from raw
// page text, attributes, or the original screenshot into this body.
export interface AgentBody { ss: string | null; page_info: string; instruction: string; problem_context: string }

const RULES = [
  'Address every element only by the exact id listed in the page description.',
  'Never invent an id, class name, or xpath. Steps carrying className or xpath are discarded.',
  'To enter a stored value, put its value_* reference in "value". To enter ordinary public text, put the literal text in "value".',
  'Never put a password, one-time code, card number, or any personal identifier in "value".',
  'Only the first page-touching step is performed; the page is then observed again. Prefer short sequences.',
].map((rule, index) => `${index + 1}. ${rule}`).join('\n');

// A flat, id-first listing. The description comes from the privacy gateway and
// is already a redacted label such as "Full name" or "Sensitive field".
export function describePage(request: StepRequest) {
  const elements = request.elements.length
    ? request.elements.map(element => `- id=${element.id} role=${element.role} label="${element.description}"`).join('\n')
    : '- (no interactive element was visible in this view)';
  const values = request.valueRefs.length
    ? `\n\nApproved stored values. Use the reference itself as "value"; the text is held on the device and is never shown here:\n${
      request.valueRefs.map(ref => `- ${ref.id} fills ${ref.target} (${ref.purpose})`).join('\n')}`
    : '';
  const image = request.sanitizedImage ? 'A redacted screenshot of this same view is attached. Masked boxes hide private content.' : 'No screenshot is attached.';
  return `Observation ${request.observationId}. ${image}\n\nInteractive elements:\n${elements}${values}`;
}

export function toAgentBody(request: StepRequest): AgentBody {
  return {
    ss: request.sanitizedImage?.base64 ?? null,
    page_info: describePage(request),
    instruction: request.sanitizedInstruction,
    problem_context: `Reply with {"thought": "...", "output": [{"action": "click|type|select|scroll|wait|finish", "id": ..., "className": null, "xpath": null, "value": ...}]}.\n\nRules:\n${RULES}`,
  };
}

// The server wraps its answer in `{ "response": { thought, output } }`. Older or
// simpler builds may answer flat, so both are accepted and nothing else is.
export function unwrapReply(body: unknown): unknown {
  if (body && typeof body === 'object' && 'response' in body) {
    const inner = (body as { response: unknown }).response;
    if (typeof inner === 'string') { try { return JSON.parse(inner); } catch { return inner; } }
    return inner;
  }
  return body;
}

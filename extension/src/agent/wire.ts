import type { Rect, StepRequest } from '../contracts';
import type { ActionHistoryEntry } from './lifecycle';

// The reasoning server speaks its own shape (`POST /agent`). Everything below is
// derived field by field from the redacted payload: there is no path from raw
// page text, attributes, or the original screenshot into this body.
export interface AgentBody { ss: string | null; page_info: string; instruction: string; problem_context: string; action_history: ActionHistoryEntry[] }
export interface ExecutionReport {
  observationId: string;
  actionType: string;
  target?: string;
  status: 'executed';
}

const RULES = [
  'Address every element only by the exact id listed in the page description.',
  'Never invent an id, class name, or xpath. Steps carrying className or xpath are discarded.',
  'To enter a stored value, put its value_* reference in "value". To enter ordinary public text, put the literal text in "value".',
  'Never put a password, one-time code, card number, or any personal identifier in "value".',
  'Only the first page-touching step is performed; the page is then observed again. Prefer short sequences.',
].map((rule, index) => `${index + 1}. ${rule}`).join('\n');

// Where a control sits in the attached screenshot, in the image's own pixels.
// The model matches what it sees to these boxes and answers with the id of an
// element the page actually exposed; visual evidence can therefore establish
// correspondence to an EXISTING id, but no coordinate ever mints one. A 2px
// halo is added so edge-adjacent controls stay distinguishable.
export function describeBox(box: Rect, width: number, height: number) {
  return `box=[${Math.max(0, Math.floor(box.x - 2))},${Math.max(0, Math.floor(box.y - 2))},${
    Math.floor(box.width + 4)},${Math.floor(box.height + 4)}] in a ${width}x${height} screenshot`;
}

// A flat, id-first listing. The description comes from the privacy gateway and
// is already a redacted label such as "Full name" or "Sensitive field". When a
// redacted screenshot is attached, each row also carries the control's box in
// the image's pixels: a visible-but-redacted course link can then be matched
// by position to its exact existing id. Coordinates are image pixels and the
// ids are opaque; nothing here lets the server address a control it was not
// already shown.
export function describePage(request: StepRequest) {
  const elements = request.elements.length
    ? request.elements.map(element => `- id=${element.id} role=${element.role} label="${element.description}"${
      request.sanitizedImage && element.bounds ? ` ${describeBox(element.bounds, request.sanitizedImage.width, request.sanitizedImage.height)}` : ''}`).join('\n')
    : '- (no interactive element was visible in this view)';
  const values = request.valueRefs.length
    ? `\n\nApproved stored values. Use the reference itself as "value"; the text is held on the device and is never shown here:\n${
      request.valueRefs.map(ref => `- ${ref.id} fills ${ref.target} (${ref.purpose})`).join('\n')}`
    : '';
  const image = request.sanitizedImage
    ? `A redacted screenshot of this same view is attached (${request.sanitizedImage.width}x${request.sanitizedImage.height} px). Masked boxes hide private content.`
    : 'No screenshot is attached.';
  return `Observation ${request.observationId}. ${image}\n\nInteractive elements:\n${elements}${values}`;
}

  export function toAgentBody(request: StepRequest, executionReport?: ExecutionReport, actionHistory: ActionHistoryEntry[] = []): AgentBody {
    const report = executionReport
      ? `\n\nExecution report from the previous observation:\n${JSON.stringify(executionReport)}\nThe action above was executed on the page that observation described, and the page has been observed again afterwards. Plan the next step from the current page_info; if the task is complete, reply with finish.`
      : '';
    // What the executor actually did with the actions planned so far, newest
    // last. The server reads this alongside the current screenshot: a success
    // means the page already reflects the action, a refused/failed/cancelled
    // entry means it does not and the current view must be reassessed.
    const history = actionHistory.length
      ? `\n\nAction history (actual execution results, oldest first):\n${JSON.stringify(actionHistory)}\nOnly "success" entries completed on the page. For refused, failed or cancelled entries, the action did not take effect: reassess the current screenshot and page_info instead of assuming the action happened.`
      : '';
  return {
    ss: request.sanitizedImage?.base64 ?? null,
    page_info: describePage(request),
    instruction: request.sanitizedInstruction,
    problem_context: `Reply with {"thought": "...", "output": [{"action": "click|type|select|scroll|wait|finish", "id": ..., "className": null, "xpath": null, "value": ...}]}\n\nRules:\n${RULES}${report}${history}`,
    action_history: actionHistory,
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

import React, { useEffect, useRef, useState } from 'react';
import type { Action, Rect, StepRequest } from '../contracts';
import { executableNow, type PlannedStep } from './protocol';
import { DEFAULT_ENDPOINT, endpointAllowed, requestStep, type TransportResult } from './transport';

interface Props {
  request: StepRequest;
  // Element geometry stays local; it is passed to the executor as the shape
  // the reviewed observation recorded, never sent to the server.
  bounds: Map<string, { role: string; bounds: Rect }>;
  observationId: string;
  signal?: AbortSignal;
  // Set while a whole task is running by itself. The panel then asks the
  // server, performs the one step it may, and reports back so the page can be
  // observed again. Every guard still applies; nothing is skipped for speed.
  auto?: boolean;
  onContinue?: () => void;
  onHalt?: (notice: string) => void;
  onLog?: (kind: 'info' | 'server' | 'action' | 'error', text: string, detail?: unknown) => void;
}
const describe = (action: Action) =>
  action.type === 'scroll' ? `Scroll ${action.direction} ${action.pixels}px`
  : action.type === 'wait' ? `Wait ${action.milliseconds}ms`
  : action.type === 'done' ? 'Finish the task'
  : action.type === 'type' ? `Type “${action.text}” into ${action.target}`
  : action.type === 'choose' ? `Choose “${action.optionText}” in ${action.target}`
  : action.type === 'fill' ? `Fill ${action.target} from approved value ${action.valueRef}`
  : action.type === 'select' ? `Select approved option ${action.optionRef} in ${action.target}`
  : `Click ${action.target}`;

export function AgentSteps({ request, bounds, observationId, signal, auto, onContinue, onHalt, onLog }: Props) {
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [plan, setPlan] = useState<TransportResult>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string>();
  // A new payload means a new page state: nothing planned earlier may be run.
  const cycled = useRef(false);
  useEffect(() => { setPlan(undefined); setOutcome(undefined); cycled.current = false; }, [request]);

  async function ask() {
    const controller = new AbortController();
    signal?.addEventListener('abort', () => controller.abort(), { once: true });
    onLog?.('info', `Sending to ${endpoint}: ${request.elements.length} elements, ${request.valueRefs.length} stored values, image ${request.sanitizedImage ? 'attached' : 'withheld'}.`, request);
    const result = await requestStep({ endpoint, request, signal: controller.signal,
      onTrace: trace => { if (trace.body !== undefined) onLog?.('server', `Reply ${trace.status}: ${trace.body.slice(0, 400)}`, trace.body);
        else if (trace.status !== undefined) onLog?.('error', `Server answered ${trace.status}.`); } });
    setPlan(result);
    if (!result.ok) onLog?.('error', `No usable step: ${result.reason}.`);
    else {
      onLog?.('server', `Thought: ${result.thought}`);
      result.steps.forEach(step => onLog?.('server', `Planned: ${describe(step.action)}`));
      result.rejected.forEach(item => onLog?.('error', `Refused step #${item.index + 1}: ${item.reason}.`));
    }
    return result;
  }
  async function perform(step: PlannedStep) {
    const target = 'target' in step.action ? step.action.target : undefined;
    const response = await chrome.runtime.sendMessage({ type: 'ACT', observationId, action: step.action,
      expect: target ? bounds.get(target) : undefined }).catch(() => undefined);
    const ok = response?.ok === true;
    onLog?.(ok ? 'action' : 'error', `${ok ? 'Performed' : 'Refused'}: ${describe(step.action)}${ok ? '' : ` — ${String(response?.error ?? 'PAGE_CHANGED')}`}`);
    return ok ? { ok: true as const } : { ok: false as const, error: String(response?.error ?? 'PAGE_CHANGED') };
  }
  async function send() {
    setBusy(true); setPlan(undefined); setOutcome(undefined);
    await ask(); setBusy(false);
  }
  async function run(step: PlannedStep) {
    setBusy(true);
    const result = await perform(step);
    setOutcome(result.ok ? 'Step performed. The page has changed, so scan again before the next step.' : `Step refused: ${result.error}.`);
    setBusy(false);
  }
  // One turn of the loop: ask, perform what this observation still allows, and
  // hand control back. The caller decides whether to observe again.
  async function cycle() {
    setBusy(true); setOutcome('Asking the server…');
    const result = await ask();
    if (!result.ok) { setBusy(false); setOutcome(undefined); onHalt?.(`The server step failed: ${result.reason}.`); return; }
    const { runnable } = executableNow(result.steps);
    if (!runnable.length) { setBusy(false); setOutcome(undefined); onHalt?.('The reply contained no step this page can perform.'); return; }
    for (const step of runnable) {
      setOutcome(`Performing: ${describe(step.action)}`);
      const performed = await perform(step);
      // PAGE_CHANGED is not a failure. It means the page moved on while the
      // server was thinking, so the reviewed observation no longer describes
      // it. The honest response is to look again, not to stop the task; the
      // caller's round limit is what prevents this from spinning.
      if (!performed.ok && performed.error === 'PAGE_CHANGED') {
        setBusy(false); setOutcome(undefined);
        onLog?.('info', 'The page changed while the server was thinking, so it is being scanned again.');
        onContinue?.(); return;
      }
      if (!performed.ok) { setBusy(false); setOutcome(undefined); onHalt?.(`A step was refused: ${performed.error}.`); return; }
      if (step.action.type === 'done') { setBusy(false); setOutcome(undefined); onHalt?.('The server reported the task is finished.'); return; }
    }
    setBusy(false); setOutcome(undefined);
    onContinue?.();
  }
  useEffect(() => {
    if (!auto || cycled.current) return;
    cycled.current = true;
    void cycle();
    // A payload is used for exactly one cycle; the effect above resets the guard
    // when a fresh one arrives.
  }, [auto, request]);

  const runnable = plan?.ok ? executableNow(plan.steps) : undefined;
  const origin = new URL(DEFAULT_ENDPOINT).origin;
  return <section aria-label="Server step" className="sub-panel">
    <div className="panel-head"><h3>Server step</h3><span className="pill">{auto ? 'Automatic' : 'Manual'}</span></div>
    <p className="foot-note">This is the only control that leaves the device. It posts exactly the redacted payload above, and nothing else.</p>
    <label className="field">
      <span>Reasoning endpoint</span>
      <input type="url" value={endpoint} placeholder="https://your-server.example/agent" disabled={busy}
        onChange={event => setEndpoint(event.target.value)} />
    </label>
    {endpoint && !endpointAllowed(endpoint) && <p className="foot-note is-warn">Use https, or http on localhost for development.</p>}
    {endpoint && !endpoint.startsWith(origin) && <p className="foot-note is-warn">The packaged manifest only allows <code>{origin}</code>. Another origin has to be added to <code>connect-src</code> and <code>host_permissions</code> first, or sending fails closed.</p>}
    {!auto && <button type="button" className="btn accent wide" disabled={busy || !endpointAllowed(endpoint)} onClick={() => void send()}>{busy ? 'Working…' : 'Send payload and read the reply'}</button>}
    {plan && !plan.ok && <p role="alert" className="banner is-danger">No usable step: {plan.reason}.</p>}
    {plan?.ok && <>
      <p className="thought"><strong>Model reasoning</strong>{plan.thought}</p>
      <ol className="plan-list">{plan.steps.map((step, index) => {
        const now = runnable && index < runnable.runnable.length;
        return <li key={index} className={now ? 'is-now' : 'is-deferred'}>
          <span className="plan-step">{describe(step.action)}</span>
          {now
            ? (auto ? <span className="plan-note">performed</span>
              : <button type="button" className="btn ghost small" disabled={busy} onClick={() => void run(step)}>Run this step</button>)
            : <span className="plan-note">deferred to the next scan</span>}
        </li>;
      })}</ol>
      {!plan.steps.length && <p className="foot-note">The reply contained no step this page can execute.</p>}
      {plan.rejected.length > 0 && <p className="foot-note is-warn">Refused: {plan.rejected.map(item => `#${item.index + 1} ${item.reason}`).join(', ')}.</p>}
      <p className="foot-note">Only the first page-touching step can run against this scan; performing it retires the reviewed observation.</p>
    </>}
    {outcome && <p role="status" className="banner">{outcome}</p>}
  </section>;
}

import React, { useEffect, useRef, useState } from 'react';
import type { Action, ExtensionError, ObservedElement, Rect, StepRequest } from '../contracts';
import { executableNow, type PlannedStep } from './protocol';
import { actionSignature, historyOutcome, LOOP_THRESHOLD, newLoopTracker, observeLoopCycle, pageSignature, type ActionHistoryEntry, type LoopTracker } from './lifecycle';
import { DEFAULT_ENDPOINT, endpointAllowed, requestStep, type TransportResult } from './transport';
import type { ExecutionReport } from './wire';
import { abortReasonOf, abortWith, explain, newRunId, summarize, titleFor, type StageEvent } from './diagnostics';

interface Props {
  request: StepRequest;
  // Element geometry stays local; it is passed to the executor as the shape
  // the reviewed observation recorded, never sent to the server.
  bounds: Map<string, { role: string; bounds: Rect; viewport?: { scrollX: number; scrollY: number; height: number } }>;
  observationId: string;
  signal?: AbortSignal;
  // The id of the run this payload belongs to, minted when the user submitted
  // the instruction. One request outside a run mints its own.
  runId?: string;
    executionReport?: ExecutionReport;
  onStage?: (stage: 'REDACTING' | 'SENDING' | 'WAITING_RESPONSE' | 'EXECUTING') => void;
  // Set while a whole task is running by itself. The panel then asks the
  // server, performs the one step it may, and reports back so the page can be
  // observed again. Every guard still applies; nothing is skipped for speed.
  auto?: boolean;
  onContinue?: () => void;
  onHalt?: (notice: string, error?: ExtensionError) => void;
  onLog?: (kind: 'info' | 'server' | 'action' | 'error', text: string, detail?: unknown) => void;
  onExecuted?: (report: ExecutionReport) => void;
  // Action history for the lifetime of one task: recorded from the executor's
  // actual result in `perform`, reset by the panel when a new task starts, and
  // sent with every planning request. Owned by the panel so it survives the
  // per-round remounts of the redaction pipeline.
  onActionOutcome?: (entry: ActionHistoryEntry) => void;
  actionHistory?: ActionHistoryEntry[];
  loopTracker?: LoopTracker;
  // Fired when the same equivalent state+action pattern has repeated the
  // configured threshold without meaningful progress; the panel stops the run.
  onLoopDetected?: (notice: string) => void;
  // The stable page identity of the observation this payload was built from.
  // Element ids and the observation id are minted per capture, so loop state
  // signatures are formed from document identity and geometry only.
  pageState?: { documentId: string; elements: ObservedElement[] };
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

const detailRows: Array<[string, string]> = [
  ['errorName', 'Error name'], ['errorMessage', 'Error message'], ['elapsedMs', 'Elapsed (ms)'],
  ['httpStatus', 'HTTP status'], ['abortSource', 'Abort source'], ['abortReason', 'Abort reason'],
  ['timeoutReached', 'Timeout reached'], ['timeoutMs', 'Timeout (ms)'], ['responseReceived', 'Response received'],
  ['callerSignalAborted', 'Caller signal aborted'], ['internalSignalAborted', 'Internal signal aborted'],
  ['receivedBytes', 'Response bytes'], ['requestBytes', 'Request bytes'], ['statusText', 'Status text'],
  ['bodyPreview', 'Body preview'], ['schema', 'Schema'], ['mismatchedField', 'Mismatched field'],
];
export function TransportFailureNotice({ error }: { error: ExtensionError }) {
  const context = error.context ?? {};
  const rows = detailRows.filter(([key]) => context[key] !== undefined);
  return <div role="alert" className="failure">
    <strong className="failure-title">{titleFor(error.code)}</strong>
    <p className="failure-text">{explain(error.code)}</p>
    <dl className="failure-facts">
      <div><dt>Code</dt><dd>{error.code}</dd></div>
      <div><dt>Stage</dt><dd>{error.stage}</dd></div>
      {error.runId && <div><dt>Run ID</dt><dd>{error.runId}</dd></div>}
    </dl>
    <p className="failure-text">{error.message}{error.cause ? ` (${error.cause})` : ''}</p>
    {(rows.length > 0 || error.originalError) && <details className="failure-details">
      <summary>Developer details</summary>
      <dl className="failure-facts is-stacked">
        {error.originalError && <div><dt>Original error</dt><dd>{error.originalError}</dd></div>}
        {rows.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{String(context[key])}</dd></div>)}
      </dl>
      <p className="foot-note">The full staged log for this run is in the panel console: right-click the panel and choose Inspect.</p>
    </details>}
  </div>;
}

export function AgentSteps({ request, bounds, observationId, signal, runId, executionReport, onStage, auto, onContinue, onHalt, onLog, onExecuted, onActionOutcome, actionHistory, loopTracker, onLoopDetected, pageState }: Props) {
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [plan, setPlan] = useState<TransportResult>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string>();
  const [activeRun, setActiveRun] = useState<string>();
  // A new payload means a new page state: nothing planned earlier may be run.
  const cycled = useRef(false);
  useEffect(() => { setPlan(undefined); setOutcome(undefined); cycled.current = false; }, [request]);
  // Loop detection counts equivalent state+action cycles across rounds, so the
  // tracker lives longer than one payload. The panel owns it — this component
  // unmounts for every re-observation — and a fresh tracker arrives with each
  // new task's history.
  const loopTrackerRef = useRef(newLoopTracker());
  useEffect(() => { if (loopTracker) loopTrackerRef.current = loopTracker; }, [loopTracker]);

  async function ask() {
    // This controller exists only to forward the panel's cancellation to one
    // request. It is never aborted from here, so anything that cancels a run
    // has to arrive through `signal` — and it arrives with its reason attached,
    // which is what the transport reports instead of guessing.
    const controller = new AbortController();
    const forward = () => abortWith(controller, abortReasonOf(signal)?.source ?? 'caller_signal',
      abortReasonOf(signal)?.reason ?? 'the panel cancelled this run without a recorded reason', { runId: run, scope: 'agent-request' });
    const run = runId ?? newRunId();
    setActiveRun(run);
    onStage?.('SENDING');
    if (signal?.aborted) forward(); else signal?.addEventListener('abort', forward, { once: true });
    // Structure only: counts and sizes, never the payload itself.
    onLog?.('info', `[${run}] Sending to ${endpoint}: ${request.elements.length} elements, ${request.valueRefs.length} stored values, image ${request.sanitizedImage ? 'attached' : 'withheld'}.`);
    const result = await requestStep({ endpoint, request, signal: controller.signal, runId: run, executionReport: executionReport, actionHistory,
      onEvent: (event: StageEvent) => {
        if (event.error) return;
        if (event.stage === 'fetch_started') onStage?.('WAITING_RESPONSE');
        if (event.stage === 'response_received') onLog?.('server', `[${run}] Reply ${event.detail?.status} in ${event.elapsedMs} ms (${event.detail?.contentType ?? 'no content-type'}).`);
        if (event.stage === 'transport_completed') onLog?.('server', `[${run}] Transport completed in ${event.elapsedMs} ms.`);
      } });
    signal?.removeEventListener('abort', forward);
    setPlan(result);
    if (!result.ok) {
      onLog?.('error', `[${run}] ${summarize(result.error)} — ${result.error.message}`, result.error);
    } else {
      onLog?.('server', `Thought: ${result.thought}`);
      result.steps.forEach(step => onLog?.('server', `Planned: ${describe(step.action)}`));
      result.rejected.forEach(item => onLog?.('error', `Refused step #${item.index + 1}: ${item.reason}.`));
    }
    return result;
  }
  async function perform(step: PlannedStep) {
    onStage?.('EXECUTING');
    const target = 'target' in step.action ? step.action.target : undefined;
    const response = await chrome.runtime.sendMessage({ type: 'ACT', observationId, action: step.action,
      expect: target ? bounds.get(target) : undefined }).catch(() => undefined);
    const ok = response?.ok === true;
    onLog?.(ok ? 'action' : 'error', `${ok ? 'Performed' : 'Refused'}: ${describe(step.action)}${ok ? '' : ` — ${String(response?.error ?? 'PAGE_CHANGED')}`}`);
    // The real executor reply — not the plan — is what history records. Only
    // success means the action took effect; refused/failed/cancelled entries
    // tell the next request the page does not reflect what was planned.
    const outcome = historyOutcome(ok, ok ? undefined : String(response?.error ?? 'PAGE_CHANGED'));
    onActionOutcome?.({ action: step.action.type === 'done' ? 'finish' : step.action.type,
      ...(target !== undefined ? { id: target } : {}),
      value: 'text' in step.action ? step.action.text : 'optionText' in step.action ? step.action.optionText
        : 'valueRef' in step.action ? step.action.valueRef : 'optionRef' in step.action ? step.action.optionRef : null,
      result: outcome.result, ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}) });
    if (ok && step.action.type !== 'done') onExecuted?.({
      observationId,
      actionType: step.action.type,
      ...('target' in step.action ? { target: step.action.target } : {}),
      status: 'executed',
    });
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
    if (!result.ok) { setBusy(false); setOutcome(undefined); onHalt?.(`${titleFor(result.error.code)}: ${explain(result.error.code)}`, result.error); return; }
    // An execution report rides along with this request: the previous action
    // succeeded and the page has been observed again. That is the normal
    // navigation lifecycle, not a stopping point, so planning continues here.
    const { runnable } = executableNow(result.steps);
    if (!runnable.length) { setBusy(false); setOutcome(undefined); onHalt?.('The reply contained no step this page can perform.'); return; }
    for (const step of runnable) {
      setOutcome(`Performing: ${describe(step.action)}`);
      // Loop detection weighs the observable state of the page this payload
      // describes plus the effective action. Both signatures avoid the
      // per-capture element ids; any meaningful state change or different
      // action resets the count. A `done` step ends the run normally, so it is
      // never counted as a cycle.
      if (pageState && step.action.type !== 'done') {
        const target = 'target' in step.action ? step.action.target : undefined;
        const cycle = observeLoopCycle(loopTrackerRef.current, {
          state: pageSignature(pageState),
          action: actionSignature(step.action, target ? bounds.get(target) : undefined),
        });
        if (cycle.loop) {
          onLog?.('error', `The same state and action have repeated ${cycle.repeats} times without progress (LOOP_DETECTED).`);
          setBusy(false); setOutcome(undefined);
          onLoopDetected?.(`The task kept repeating the same step on an unchanged page, so it was stopped after ${cycle.repeats} equivalent cycles (LOOP_DETECTED).`);
          return;
      }
      }
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
      if (!performed.ok) {
        setBusy(false); setOutcome(undefined);
        // The refusal is already in the action history; the next planning
        // request carries it so the model can reassess from the fresh page
        // instead of the run ending on a step the browser declined. The round
        // limit and loop detection bound the repetition — an identical retry
        // eight times on an unchanged page stops the run as LOOP_DETECTED.
        onLog?.('info', `The step was not performed (${performed.error}); observing again so the next request reflects that.`);
        onContinue?.(); return;
      }
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
    {activeRun && <p className="run-id">Run {activeRun}</p>}
    <p className="foot-note">This is the only control that leaves the device. It posts exactly the redacted payload above, and nothing else.</p>
    <label className="field">
      <span>Reasoning endpoint</span>
      <input type="url" value={endpoint} placeholder="https://your-server.example/agent" disabled={busy}
        onChange={event => setEndpoint(event.target.value)} />
    </label>
    {endpoint && !endpointAllowed(endpoint) && <p className="foot-note is-warn">Use https, or http on localhost for development.</p>}
    {endpoint && !endpoint.startsWith(origin) && <p className="foot-note is-warn">The packaged manifest only allows <code>{origin}</code>. Another origin has to be added to <code>connect-src</code> and <code>host_permissions</code> first, or sending fails closed.</p>}
    {!auto && <button type="button" className="btn accent wide" disabled={busy || !endpointAllowed(endpoint)} onClick={() => void send()}>{busy ? 'Working…' : 'Send payload and read the reply'}</button>}
    {plan && !plan.ok && <TransportFailureNotice error={plan.error} />}
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

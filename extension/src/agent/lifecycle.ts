import type { Action, ErrorCode, ExtensionError, ObservedElement, TaskState } from '../contracts';

export const initialState = (): TaskState => ({ status: 'idle', generation: 0 });
export function invalidate(state: TaskState, status: 'stopped' | 'paused' | 'failed', error?: ErrorCode, errorDetail?: ExtensionError): TaskState {
  const next = { ...state, status, error, generation: state.generation + 1, ...(errorDetail ? { errorDetail } : {}) };
  delete next.observationId;
  if (!errorDetail) delete next.errorDetail;
  return next;
}

// Every generation change and every lifecycle event prints one timestamped,
// structure-only console line, so a RESTARTED refusal can be traced back to
// the exact caller and wall-clock instant from the panel's console alone
// (right-click the panel → Inspect; the service worker's own console is not
// reachable in this harness, so the panel's STATUS poll is what surfaces
// cold-start recover() here). Identifiers and counts only — never page text,
// screenshots or payload contents, matching the diagnostics.ts rule.
export function lifecycleLog(event: string, detail: Record<string, string | number | boolean | undefined>): void {
  console.info(`[LIFECYCLE][${new Date().toISOString()}] ${event} ` +
    Object.entries(detail).filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : value}`).join(' '));
}
// Timestamped snapshot of the current task state, for reading generations and
// observation ids from the panel side without any new state plumbing.
export function lifecycleStateLog(event: string, state: TaskState): void {
  lifecycleLog(event, { status: state.status, generation: state.generation,
    taskId: state.taskId?.slice(0, 8), observationId: state.observationId?.slice(0, 8),
    tabId: state.tabId, error: state.error });
}

export const CAPTURE_RETRY_LIMIT = 4;
export const CAPTURE_RETRY_BACKOFF_MS = 250;
export function nextCaptureRetry(completedRetries: number, limit = CAPTURE_RETRY_LIMIT) {
  return completedRetries >= limit ? { retry: false as const, completedRetries }
    : { retry: true as const, completedRetries: completedRetries + 1 };
}
export function acceptsResult(state: TaskState, taskId: string, generation: number): boolean {
  return state.status === 'observing' && state.taskId === taskId && state.generation === generation;
}
export function recover(state: TaskState): TaskState {
  return state.status === 'observing' || state.status === 'paused'
    ? invalidate(state, 'paused', 'RESTARTED') : state;
}

// How long a normal run may go on. The run continues across successful actions
// until finish, a manual stop, loop detection, this limit, or a genuine
// unrecoverable failure — a successful action never terminates a run by itself.
export const RUN_LIMIT = 32;

// The panel asks this before scheduling the next round of a run. A round is one
// page-touching step; round N is allowed exactly when N-1 rounds have run, so
// the limit-th round completes and the round after the limit never starts.
export function nextRound(round: number, limit = RUN_LIMIT): { continue: true; round: number } | { continue: false; notice: string } {
  if (round >= limit) return { continue: false, notice: `Stopped after ${limit} rounds. Run the task again to continue.` };
  return { continue: true, round: round + 1 };
}

// ---------------------------------------------------------------------------
// Action history
//
// What the executor actually did with each planned action, for the lifetime of
// one task. The history is recorded at the executor boundary — never from the
// plan — because the model must see what happened, not what was proposed.
export type ActionOutcome = 'success' | 'refused' | 'failed' | 'cancelled';
export interface ActionHistoryEntry {
  action: string;
  id?: string;
  value?: string | null;
  result: ActionOutcome;
  reason?: string;
}
export const newActionHistory = (): ActionHistoryEntry[] => [];
// One history entry per executor attempt. Undefined fields are omitted so the
// wire shape stays minimal; `value` is kept explicit (null means no input).
export function recordActionHistory(history: ActionHistoryEntry[], entry: ActionHistoryEntry): ActionHistoryEntry[] {
  history.push({
    action: entry.action,
    ...(entry.id !== undefined ? { id: entry.id } : {}),
    value: entry.value ?? null,
    result: entry.result,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  });
  return history;
}
// Map the executor's reply to the history outcome. The executor speaks one
// vocabulary: `{ ok: true }` or an error code. Only success completed the
// action; ACTION_FAILED was attempted but did not complete; PAGE_CHANGED means
// the page moved under the attempt (not completed, not the action's fault);
// every other code is a refusal — the action was not performed.
export function historyOutcome(ok: boolean, error?: string): { result: ActionOutcome; reason?: string } {
  if (ok) return { result: 'success' };
  if (error === 'ACTION_FAILED') return { result: 'failed', reason: error };
  if (error === 'PAGE_CHANGED') return { result: 'cancelled', reason: error };
  return { result: 'refused', reason: error };
}
export const resetActionHistory = (): ActionHistoryEntry[] => newActionHistory();

// ---------------------------------------------------------------------------
// Loop detection
//
// A loop is the SAME observable page state plus the SAME effective action,
// repeated without meaningful progress. Element ids are minted per observation
// and must never enter a signature; document identity, revision, element
// geometry and the filled flags are what distinguish one state from another.
export const LOOP_THRESHOLD = 8;
// Lightweight and stable: the document the observation describes and the
// geometry/role/filled shape of every exposed control. No page text, no ids
// that churn between captures, no screenshots. The revision counter is left
// out deliberately: capture-time churn can bump it without any observable
// change, which would hide a genuine loop; anything a user can see changes
// geometry, input state or the document itself.
export function pageSignature(dom: { documentId: string; elements: ObservedElement[] }): string {
  const shape = dom.elements.map(element =>
    `${element.role}${element.filled ? '*' : ''}@${Math.round(element.bounds.x)},${Math.round(element.bounds.y)},${Math.round(element.bounds.width)},${Math.round(element.bounds.height)}`);
  return [dom.documentId, shape.join(';')].join('|');
}
// What makes two actions the same action: the kind of step, which control it
// addresses (role and reviewed geometry — not the per-observation id) and the
// input it carries, if any.
export function actionSignature(action: Action, control?: { role: string; bounds: { x: number; y: number; width: number; height: number } }): string {
  const value = action.type === 'type' ? action.text : action.type === 'choose' ? action.optionText
    : action.type === 'fill' ? action.valueRef : action.type === 'select' ? action.optionRef
    : action.type === 'scroll' ? `${action.direction}:${action.pixels}` : action.type === 'wait' ? String(action.milliseconds)
    : action.type === 'key' ? action.key : action.type === 'navigate' ? action.url : null;
  const target = control ? `${control.role}@${Math.round(control.bounds.x)},${Math.round(control.bounds.y)},${Math.round(control.bounds.width)},${Math.round(control.bounds.height)}` : '';
  return [action.type, target, value ?? ''].join('|');
}
export interface LoopCycle { state: string; action: string }
export interface LoopTracker { cycle?: LoopCycle; repeats: number }
export const newLoopTracker = (): LoopTracker => ({ repeats: 0 });
// One attempted cycle of (state, action). A run is looping only when the same
// equivalent pair repeats LOOP_THRESHOLD times in a row; any meaningful state
// change — navigation, layout change, a field now holding input — or any
// different action resets the count. PAGE_CHANGED is just a state change here:
// it goes through the normal fresh-observation flow and is never a loop itself.
export function observeLoopCycle(tracker: LoopTracker, cycle: LoopCycle): { repeats: number; loop: boolean } {
  const same = tracker.cycle !== undefined && tracker.cycle.state === cycle.state && tracker.cycle.action === cycle.action;
  const repeats = same ? tracker.repeats + 1 : 1;
  tracker.cycle = cycle;
  tracker.repeats = repeats;
  return { repeats, loop: repeats >= LOOP_THRESHOLD };
}
export function haltReason(input: { detectorError?: string; status: TaskState['status'] }): string | undefined {
  if (input.detectorError) return `The scan did not complete (${input.detectorError}), so the run stopped.`;
  if (input.status === 'failed' || input.status === 'stopped') return 'The capture failed, so the run stopped.';
  return undefined;
}

// What an automatic run should do with the state it is looking at.
export type RoundVerdict = { verdict: 'continue' } | { verdict: 'retry' | 'halt'; notice: string };
// A live page moves on its own — a notification poll, a lazy-loaded image — and
// any of it retires the capture in progress with PAGE_CHANGED. That leaves the
// task `paused`, which is also what a finished capture looks like, so a run that
// only watched `status` waited forever for a round that had already died. The
// error tells the two apart, but only once it is known to belong to this round:
// `state.error` outlives the navigation that set it, so it is read only from a
// generation at or past the one this round's capture was launched at.
export function roundVerdict(input: { detectorError?: string; status: TaskState['status'];
  error?: ErrorCode; generation: number; roundGeneration?: number }): RoundVerdict {
  const halt = haltReason(input);
  if (halt) return { verdict: 'halt', notice: halt };
  const mine = input.roundGeneration !== undefined && input.generation >= input.roundGeneration;
  if (!mine || !input.error) return { verdict: 'continue' };
  // Recoverable: the page moved, or the worker restarted under us. Nothing is
  // wrong with the task, only with the view of the page, so look again.
  if (input.error === 'PAGE_CHANGED' || input.error === 'RESTARTED' || input.error === 'TARGET_CHANGED')
    return { verdict: 'retry', notice: 'The page changed during the scan, so it is being scanned again.' };
  return { verdict: 'halt', notice: 'The scan could not be completed, so the run stopped.' };
}

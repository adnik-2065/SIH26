import type { ErrorCode, TaskState } from '../contracts';

export const initialState = (): TaskState => ({ status: 'idle', generation: 0 });
export function invalidate(state: TaskState, status: 'stopped' | 'paused' | 'failed', error?: ErrorCode): TaskState {
  const next = { ...state, status, error, generation: state.generation + 1 };
  delete next.observationId;
  return next;
}
export function acceptsResult(state: TaskState, taskId: string, generation: number): boolean {
  return state.status === 'observing' && state.taskId === taskId && state.generation === generation;
}
export function recover(state: TaskState): TaskState {
  return state.status === 'observing' || state.status === 'paused'
    ? invalidate(state, 'paused', 'RESTARTED') : state;
}

// Why an automatic run must stop, or undefined to continue. Kept out of the
// panel so it can be reasoned about directly: `state.error` is deliberately not
// an input. It still describes the navigation that brought the user to the page
// and is cleared only when the next observation is published, so consulting it
// would halt every run at the moment it started.
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

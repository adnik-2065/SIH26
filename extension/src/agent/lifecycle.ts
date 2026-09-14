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

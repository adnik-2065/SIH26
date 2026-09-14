import { describe, expect, it } from 'vitest';
import { acceptsResult, invalidate, recover } from '../../src/agent/lifecycle';
import type { TaskState } from '../../src/contracts';
const running: TaskState = { taskId: 'task_1', observationId: 'obs_1', tabId: 1, origin: 'https://example.test', status: 'observing', generation: 3 };
describe('task lifecycle', () => {
  it('accepts only the pending task generation', () => {
    expect(acceptsResult(running, 'task_1', 3)).toBe(true);
    expect(acceptsResult(running, 'task_2', 3)).toBe(false);
    expect(acceptsResult(running, 'task_1', 2)).toBe(false);
  });
  it.each(['stopped', 'paused', 'failed'] as const)('rejects delayed results after %s', status => {
    const next = invalidate(running, status);
    expect(next.observationId).toBeUndefined();
    expect(acceptsResult(next, 'task_1', 3)).toBe(false);
  });
  it('requires fresh observation after a worker restart', () => {
    const next = recover(running);
    expect(next.status).toBe('paused'); expect(next.error).toBe('RESTARTED');
    expect(next.observationId).toBeUndefined();
    expect(acceptsResult(next, 'task_1', 3)).toBe(false);
  });
  it('does not revive stopped tasks on restart', () => {
    const stopped = invalidate(running, 'stopped');
    expect(recover(stopped)).toEqual(stopped);
  });
});

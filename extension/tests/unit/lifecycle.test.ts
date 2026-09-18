import { describe, expect, it } from 'vitest';
import { acceptsResult, haltReason, invalidate, recover, roundVerdict } from '../../src/agent/lifecycle';
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

describe('stopping an automatic run', () => {
  it('ignores the navigation error a paused task is still carrying', () => {
    // Reaching a login page pauses the task with PAGE_CHANGED. That error
    // survives on the state until the next observation is published, so a run
    // started from this page must not read it as its own failure.
    const paused = invalidate({ status: 'paused', generation: 3, taskId: 't', tabId: 1, origin: 'https://example.test' }, 'paused', 'PAGE_CHANGED');
    expect(paused.error).toBe('PAGE_CHANGED');
    expect(haltReason({ status: paused.status })).toBeUndefined();
  });
  it('stops when this run\'s own scan fails', () => {
    expect(haltReason({ detectorError: 'Text reading failed.', status: 'paused' })).toContain('Text reading failed.');
    expect(haltReason({ status: 'failed' })).toContain('capture failed');
    expect(haltReason({ status: 'stopped' })).toContain('capture failed');
    expect(haltReason({ status: 'observing' })).toBeUndefined();
  });
});

describe('deciding what a run does next', () => {
  // The state a capture launched at generation 5 rests in once the page moved
  // underneath it: paused, no observation, carrying PAGE_CHANGED at 6.
  const invalidated = invalidate({ status: 'observing', generation: 5, taskId: 't', observationId: 'obs_1', tabId: 1, origin: 'https://example.test' }, 'paused', 'PAGE_CHANGED');
  it('scans again when this round\'s own capture was retired by the page moving', () => {
    const outcome = roundVerdict({ status: invalidated.status, error: invalidated.error, generation: invalidated.generation, roundGeneration: 5 });
    expect(outcome.verdict).toBe('retry');
  });
  it('waits through the navigation error a run inherited from before it started', () => {
    // The same state, but no round has been launched yet: the error describes
    // how the user arrived, not anything this run did.
    expect(roundVerdict({ status: invalidated.status, error: invalidated.error, generation: invalidated.generation }).verdict).toBe('continue');
    expect(roundVerdict({ status: invalidated.status, error: invalidated.error, generation: invalidated.generation, roundGeneration: 9 }).verdict).toBe('continue');
  });
  it('continues through a capture that finished cleanly', () => {
    expect(roundVerdict({ status: 'paused', generation: 5, roundGeneration: 5 }).verdict).toBe('continue');
    expect(roundVerdict({ status: 'observing', generation: 5, roundGeneration: 5 }).verdict).toBe('continue');
  });
  it('stops on an error no repeat scan can clear', () => {
    const outcome = roundVerdict({ status: 'paused', error: 'ACCESS_REQUIRED', generation: 6, roundGeneration: 5 });
    expect(outcome).toEqual({ verdict: 'halt', notice: expect.stringContaining('run stopped') });
    expect(roundVerdict({ status: 'failed', error: 'CAPTURE_FAILED', generation: 6, roundGeneration: 5 }).verdict).toBe('halt');
    expect(roundVerdict({ detectorError: 'Text reading failed.', status: 'paused', error: 'PAGE_CHANGED', generation: 6, roundGeneration: 5 }).verdict).toBe('halt');
  });
});

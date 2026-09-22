import { describe, expect, it, vi } from 'vitest';
import { accepts, advance, beginRun, isActive, replaceRun, type RunLogEntry, type RunState } from '../../src/agent/run';

const clock = (start = 1_700_000_000_000) => { let now = start; return { now: () => (now += 10), set: (value: number) => { now = value; } }; };
const collect = () => { const entries: RunLogEntry[] = []; return { log: (entry: RunLogEntry) => entries.push(entry), entries }; };

describe('one instruction, one run', () => {
  it('starts a run from idle and reports its stage', () => {
    const { log, entries } = collect();
    const outcome = beginRun(undefined, { now: clock().now, runId: 'run_a', log });
    expect(outcome).toMatchObject({ started: true, run: { runId: 'run_a', stage: 'PREPARING', round: 1 } });
    expect(entries[0]).toMatchObject({ runId: 'run_a', message: 'Run started.' });
  });
  it('ignores a second submit while a run is active, and says which run holds it', () => {
    const first = beginRun(undefined, { runId: 'run_a' });
    if (!first.started) throw new Error('expected a run');
    const active = advance(first.run, 'CAPTURING');
    const { log, entries } = collect();
    const second = beginRun(active, { runId: 'run_b', log });
    expect(second).toMatchObject({ started: false, reason: 'DUPLICATE_RUN_IGNORED', active: { runId: 'run_a', stage: 'CAPTURING' } });
    expect(entries[0]).toMatchObject({ runId: 'run_a', stage: 'CAPTURING', reason: 'DUPLICATE_RUN_IGNORED' });
  });
  it.each(['COMPLETED', 'FAILED', 'CANCELLED', 'IDLE'] as const)('starts a new run once the previous one is %s', finished => {
    const previous: RunState = { runId: 'run_a', stage: finished, startedAt: 0, updatedAt: 0, round: 3 };
    const outcome = beginRun(previous, { runId: 'run_b' });
    expect(outcome.started).toBe(true);
    expect(isActive(previous)).toBe(false);
  });
  it('records the old run, its stage and the reason when a run is replaced', () => {
    const active: RunState = { runId: 'run_a', stage: 'WAITING_RESPONSE', startedAt: 0, updatedAt: 0, round: 2 };
    const { log, entries } = collect();
    const next = replaceRun(active, 'the user submitted a different task', { runId: 'run_b', log });
    expect(next.runId).toBe('run_b');
    expect(entries[0]).toMatchObject({ runId: 'run_a', stage: 'WAITING_RESPONSE', reason: 'the user submitted a different task' });
    expect(entries[1]).toMatchObject({ runId: 'run_b', previousRunId: 'run_a' });
  });
});

describe('run stages', () => {
  const run = (stage: RunState['stage'] = 'PREPARING'): RunState => ({ runId: 'run_a', stage, startedAt: 0, updatedAt: 0, round: 1 });
  it('moves forward through the pipeline', () => {
    let state = run();
    for (const next of ['CAPTURING', 'DETECTING', 'REDACTING', 'SENDING', 'WAITING_RESPONSE', 'EXECUTING', 'COMPLETED'] as const) {
      state = advance(state, next);
      expect(state.stage).toBe(next);
    }
  });
  it('refuses to be dragged backwards by a late callback', () => {
    const state = advance(run('WAITING_RESPONSE'), 'DETECTING');
    expect(state.stage).toBe('WAITING_RESPONSE');
  });
  it('counts a new round when a later stage returns to capturing', () => {
    const next = advance(run('EXECUTING'), 'CAPTURING');
    expect(next).toMatchObject({ stage: 'CAPTURING', round: 2 });
  });
  it('cannot be revived after a terminal stage', () => {
    expect(advance(run('CANCELLED'), 'SENDING').stage).toBe('CANCELLED');
    expect(advance(run('COMPLETED'), 'CAPTURING').stage).toBe('COMPLETED');
  });
  it('can always be stopped', () => {
    expect(advance(run('SENDING'), 'CANCELLED').stage).toBe('CANCELLED');
    expect(advance(run('DETECTING'), 'FAILED').stage).toBe('FAILED');
  });
  it('only accepts callbacks from the active run', () => {
    const active = run('SENDING');
    expect(accepts(active, 'run_a')).toBe(true);
    expect(accepts(active, 'run_b')).toBe(false);
    expect(accepts(active, undefined)).toBe(false);
    expect(accepts(run('COMPLETED'), 'run_a')).toBe(false);
    expect(accepts(undefined, 'run_a')).toBe(false);
  });
  it('mints a distinct id per run', () => {
    const a = beginRun(undefined, { now: () => 1_700_000_000_000 });
    const b = beginRun(undefined, { now: () => 1_700_000_000_000 });
    if (!a.started || !b.started) throw new Error('expected runs');
    expect(a.run.runId).not.toBe(b.run.runId);
  });
  it('does not log anything when no logger is supplied', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    advance(run(), 'CAPTURING');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

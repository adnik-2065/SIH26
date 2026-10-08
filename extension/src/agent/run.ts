import { newRunId } from './diagnostics';

// One user instruction is one run. Every stage of the pipeline reports into
// this, so "is something already running?" has a single synchronous answer
// rather than being inferred from React state that has not re-rendered yet.
export const RUN_STAGES = ['IDLE', 'PREPARING', 'CAPTURING', 'DETECTING', 'REDACTING', 'SENDING',
  'WAITING_RESPONSE', 'EXECUTING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type RunStage = typeof RUN_STAGES[number];
export const TERMINAL_STAGES: readonly RunStage[] = ['IDLE', 'COMPLETED', 'FAILED', 'CANCELLED'];
export const isActive = (run?: RunState): run is RunState => !!run && !TERMINAL_STAGES.includes(run.stage);

export interface RunState {
  runId: string;
  stage: RunStage;
  startedAt: number;
  updatedAt: number;
  round: number;
}
export type StartOutcome =
  | { started: true; run: RunState }
  // A second submit of the same instruction is ignored rather than racing the
  // first: two runs would capture, redact and act on the same tab at once.
  | { started: false; reason: 'DUPLICATE_RUN_IGNORED'; active: RunState };

export interface RunLogEntry { runId: string; stage: RunStage; at: string; message: string; previousRunId?: string; reason?: string }
export type RunLogger = (entry: RunLogEntry) => void;

export function beginRun(active: RunState | undefined, options: { now?: () => number; runId?: string; log?: RunLogger } = {}): StartOutcome {
  const now = options.now ?? Date.now;
  const previousRunId = active?.runId;
  if (isActive(active)) {
    options.log?.({ runId: active.runId, stage: active.stage, at: new Date(now()).toISOString(),
      message: 'A run is already active, so this submission was ignored.', reason: 'DUPLICATE_RUN_IGNORED' });
    return { started: false, reason: 'DUPLICATE_RUN_IGNORED', active };
  }
  const run: RunState = { runId: options.runId ?? newRunId(new Date(now())), stage: 'PREPARING',
    startedAt: now(), updatedAt: now(), round: 1 };
  options.log?.({ runId: run.runId, stage: run.stage, at: new Date(run.startedAt).toISOString(),
    message: 'Run started.', ...(previousRunId ? { previousRunId } : {}) });
  return { started: true, run };
}

// Replacing a live run is legitimate — the user asks for something else — but it
// is never silent: the old id, its stage and the reason are recorded first.
export function replaceRun(active: RunState | undefined, reason: string,
  options: { now?: () => number; runId?: string; log?: RunLogger } = {}): RunState {
  const now = options.now ?? Date.now;
  const previousRunId = active?.runId;
  if (isActive(active)) {
    options.log?.({ runId: active.runId, stage: active.stage, at: new Date(now()).toISOString(),
      message: 'Run cancelled because a newer run replaced it.', reason });
  }
  const run: RunState = { runId: options.runId ?? newRunId(new Date(now())), stage: 'PREPARING',
    startedAt: now(), updatedAt: now(), round: 1 };
  options.log?.({ runId: run.runId, stage: run.stage, at: new Date(run.startedAt).toISOString(),
    message: 'Run started.', reason, ...(previousRunId ? { previousRunId } : {}) });
  return run;
}

// Stages move forward through the pipeline, or to a terminal stage from
// anywhere. A late callback from an earlier stage cannot drag a run backwards.
const order = new Map(RUN_STAGES.map((stage, index) => [stage, index]));
export function advance(run: RunState, stage: RunStage, options: { now?: () => number; log?: RunLogger } = {}): RunState {
  const now = options.now ?? Date.now;
  if (run.stage === stage) return run;
  const terminal = TERMINAL_STAGES.includes(stage);
  if (!terminal && TERMINAL_STAGES.includes(run.stage)) return run;
  // A new round legitimately returns to CAPTURING; that is the only backward
  // move, and the caller marks it by incrementing the round.
  if (!terminal && order.get(stage)! < order.get(run.stage)! && stage !== 'CAPTURING') return run;
  const next: RunState = { ...run, stage, updatedAt: now(), round: stage === 'CAPTURING' && order.get(run.stage)! > order.get('CAPTURING')! ? run.round + 1 : run.round };
  options.log?.({ runId: next.runId, stage, at: new Date(next.updatedAt).toISOString(), message: `Run stage: ${stage}.` });
  return next;
}

// Does a result that arrived late still belong to the run in progress? Every
// asynchronous stage asks this before it writes anything.
export const accepts = (active: RunState | undefined, runId: string | undefined): boolean =>
  !!runId && isActive(active) && active.runId === runId;

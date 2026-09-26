import { PanelCommandSchema, PageChangedSchema, TaskStateSchema, type ErrorCode, type ExtensionError, type TaskState } from '../contracts';
import { acceptsResult, initialState, invalidate, lifecycleLog, lifecycleStateLog, recover } from '../agent/lifecycle';
import { observeTab } from '../capture/observe';
import { captureEndingClass, emptyMutationSummary, PageChangedError, pageChangedDetail } from '../capture/stability';
import { CaptureError, captureErrorCategory } from '../capture/errors';

let state = initialState();
let captureController: AbortController | undefined;
let captureDone: Promise<unknown> = Promise.resolve();
// When a capture ended because the page navigated mid-capture, the new page
// needs to finish loading before the next attempt can photograph it. The
// background prefers the browser's own signal — tabs.onUpdated fires with
// status 'complete' when the navigation settles — and a bounded fallback
// (a document that never finishes loading, or a same-page transition that
// fires no event) keeps the retry bounded. The panel's existing retry
// backoff (CAPTURE_RETRY_BACKOFF_MS × attempt) runs in parallel.
let awaitingLoad = false;
let settleMs = 0;
const SETTLE_FALLBACK_MS = 2000; // bounded fallback when no load event arrives
const SETTLE_CHECK_PHASE_MS = 250; // a CHECK-phase ending caught only the tail of a transition
let settleTimer: ReturnType<typeof setTimeout> | undefined;
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
// Resolve only once the tab's current navigation has settled, or after the
// bounded fallback. A load that already completed returns immediately.
function awaitLoadSettled(tabId: number | undefined, fallbackMs: number): Promise<void> {
  if (tabId === undefined) return Promise.resolve();
  const event = new Promise<void>(resolve => {
    const listener = (changedTabId: number, change: chrome.tabs.TabChangeInfo) => {
      if (changedTabId === tabId && change.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return Promise.race([event, delay(fallbackMs)]);
}
const publish = (message: unknown) => { void chrome.runtime.sendMessage(message).catch(() => {}); };
const persist = async () => {
  await chrome.storage.session.set({ task: state });
  publish({ type: 'STATE', state });
};
const ready = (async () => {
  const coldStartAt = Date.now();
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = TaskStateSchema.safeParse((await chrome.storage.session.get('task')).task);
  state = saved.success ? recover(saved.data) : initialState();
  // The one RESTARTED producer. Logged from the recovered state: a persisted
  // observing/paused task shows exactly which generation was invalidated and
  // which one replaced it. elapsedMs exposes how long this cold start took —
  // the delay an ACT that arrives during it would see.
  lifecycleStateLog('worker_cold_start_recover', state);
  lifecycleLog('worker_cold_start_timing', {
    recovered: saved.success, savedStatus: saved.success ? saved.data.status : undefined,
    elapsedMs: Date.now() - coldStartAt,
  });
  await persist();
})();
let queue: Promise<unknown> = ready;
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}
async function release(tabId?: number) {
  if (tabId !== undefined) await chrome.tabs.sendMessage(tabId, { type: 'RELEASE' }, { frameId: 0 }).catch(() => {});
}
async function pause(error: ErrorCode, status: 'paused' | 'failed' | 'stopped' = 'paused', detail?: ExtensionError) {
  const tabId = state.tabId;
  lifecycleLog('generation_invalidate', {
    caller: 'pause', oldGeneration: state.generation, newGeneration: state.generation + 1,
    reason: error, status, tabId, cause: detail?.cause?.slice(0, 120), observationId: state.observationId?.slice(0, 8),
  });
  state = invalidate(state, status, error, detail);
  captureController?.abort();
  if (status === 'stopped') state = { status, generation: state.generation, error };
  await persist();
  await release(tabId);
  await captureDone.catch(() => {});
}
function launch(snapshot: TaskState) {
  const { taskId, tabId, windowId, origin, observationId, generation } = snapshot;
  if (!taskId || tabId === undefined || windowId === undefined || !origin || !observationId) return;
  const check = () => { if (!acceptsResult(state, taskId, generation)) throw new Error('STOPPED'); };
  captureController = new AbortController();
  // One shared record per capture: observeTab fills it via onEnd, and the
  // catch block reads it to decide how the next attempt should be scheduled.
  const end = { phase: 'NONE' as 'NONE' | 'COLLECT' | 'CHECK', steps: [] as string[], signalAborted: false };
  const capture = observeTab(tabId, windowId, origin, observationId, check, captureController.signal, async (tile, index, count) => {
    check();
    // Await delivery of each bounded image instead of sending the entire page
    // in one message. The panel commits only after the final stability check.
    await chrome.runtime.sendMessage({ type: 'CAPTURE_TILE', state: snapshot, tile, index, count });
    check();
  }, context => {
    end.phase = context.phase; end.steps = context.steps; end.signalAborted = context.signalAborted;
  });
  captureDone = capture;
  void capture.then(observation => serial(async () => {
    check();
    state = { ...state, status: 'paused' };
    await persist();
    publish({ type: 'OBSERVATION', state, observation });
    // Raw images exist only in this call and an opt-in panel preview, never storage.
  })).catch(error => serial(async () => {
    if (acceptsResult(state, taskId, generation)) {
      // How did the capture end? A page transition is not a failure: it must
      // be retried against the NEW page, which is what the panel's retry
      // lifecycle (CAPTURE_RETRY_LIMIT) is for. The classifier reads the same
      // error the block would have sorted by hand. Ambiguous frame/message
      // errors are decided by evidence taken at throw time: with a navigation
      // still loading they are the retryable document-swap race; idle they
      // stay genuine capture failures.
      const navigationInFlight = await chrome.tabs.get(tabId)
        .then(tab => tab?.status === 'loading').catch(() => true);
      const ending = captureEndingClass(error, { navigationInFlight });
      if (ending === 'PAGE_CHANGED') {
        // The retry must photograph the NEW page, not a mid-load frame. Prefer
        // the browser's own completion signal; fall back to a bounded wait
        // sized by how far this attempt got before the page moved.
        if (!awaitingLoad) {
          awaitingLoad = true;
          const fallback = end.phase === 'CHECK' ? SETTLE_CHECK_PHASE_MS
            : end.phase === 'COLLECT' ? SETTLE_FALLBACK_MS : SETTLE_FALLBACK_MS;
          settleTimer = setTimeout(() => { awaitingLoad = false; }, fallback);
          settleMs = fallback;
        }
        const detail = error instanceof PageChangedError ? error.detail
          : pageChangedDetail('PAGE_CHANGED_NAVIGATION', emptyMutationSummary(), undefined, undefined,
            'The page navigated while it was being captured; the next capture will photograph the new page.');
        await pause('PAGE_CHANGED', 'paused', detail);
        return;
      }
      if (error instanceof CaptureError) await pause(captureErrorCategory(error.detail.code),
        captureErrorCategory(error.detail.code) === 'PAGE_CHANGED' ? 'paused' : 'failed', error.detail);
      else if (error instanceof PageChangedError) await pause('PAGE_CHANGED', 'paused', error.detail);
      else if (error instanceof Error && error.message === 'PAGE_CHANGED') await pause('PAGE_CHANGED');
      else await pause(error instanceof Error && error.message === 'CAPTURE_TOO_LARGE' ? 'CAPTURE_TOO_LARGE' : 'CAPTURE_FAILED', 'failed');
    }
  }));
}

chrome.action.onClicked.addListener(tab => {
  if (tab.id !== undefined) void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});
chrome.runtime.onMessage.addListener((raw: unknown, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  const isPanel = sender.url === chrome.runtime.getURL('panel.html');
  if (sender.tab && !isPanel) {
    const parsed = PageChangedSchema.safeParse(raw);
    if (parsed.success && sender.frameId === 0) void serial(async () => {
      if (sender.tab?.id === state.tabId && parsed.data.observationId === state.observationId)
        await pause('PAGE_CHANGED', 'paused', parsed.data.detail);
    });
    return;
  }
  if (!isPanel) return;
  const parsed = PanelCommandSchema.safeParse(raw);
  if (!parsed.success) { reply({ ok: false, error: 'INVALID_MESSAGE' }); return; }
  void serial(async () => {
    const command = parsed.data;
    if (command.type === 'STOP') await pause('STOPPED', 'stopped');
    if (command.type === 'ACT') {
      // The panel already validated the server's proposal. The worker repeats
      // the checks it alone owns: the same tab, the same origin, and a settled
      // observation that is still the current one. `paused` is the state a
      // finished capture rests in; invalidation drops the observation id, so a
      // page that moved can no longer be matched here at all.
      if (state.status !== 'paused' || state.tabId === undefined || command.observationId !== state.observationId) {
        lifecycleLog('act_gate_refuse', { status: state.status, reason: command.observationId !== state.observationId ? 'observationId_mismatch' : 'status_not_paused',
          workerGeneration: state.generation, workerObservationId: state.observationId?.slice(0, 8), commandObservationId: command.observationId?.slice(0, 8), error: 'PAGE_CHANGED' });
        return { ok: false, error: 'PAGE_CHANGED', state };
      }
      const tab = await chrome.tabs.get(state.tabId).catch(() => undefined);
      if (!tab?.url || new URL(tab.url).origin !== state.origin) return { ok: false, error: 'PAGE_CHANGED', state };
      // A wait never reaches the page; holding it here keeps the content
      // script's element map untouched while time passes.
      if (command.action.type === 'wait') {
        await new Promise(resolve => setTimeout(resolve, command.action.type === 'wait' ? command.action.milliseconds : 0));
        return { ok: true, state };
      }
      const forwarded = { type: 'ACT' as const, observationId: command.observationId, action: command.action,
        resolved: command.resolved, expect: command.expect };
      const result = await chrome.tabs.sendMessage(state.tabId, forwarded, { frameId: 0 }).catch(() => ({ error: 'PAGE_CHANGED' as const }));
      if (result?.error) { if (result.error === 'PAGE_CHANGED') await pause('PAGE_CHANGED'); return { ok: false, error: result.error, state }; }
      return { ok: true, state };
    }
    if (command.type === 'START' || command.type === 'OBSERVE') {
      if (state.status === 'observing') return { ok: false, error: 'BUSY', state };
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined || !tab.url || !/^https?:/.test(tab.url)) return { ok: false, error: 'ACCESS_REQUIRED', state };
      if (command.type === 'OBSERVE' && (state.tabId !== tab.id || state.origin !== new URL(tab.url).origin)) return { ok: false, error: 'ACCESS_REQUIRED', state };
      await release(state.tabId);
      // A retry scheduled while a navigation was still settling waits for the
      // browser's own completion signal (bounded) before the next observation
      // id is minted, so the capture begins against the settled page rather
      // than a mid-load frame. Other states (a first scan, or a retry after a
      // stability change that is not a navigation) pay nothing.
      if (awaitingLoad) {
        awaitingLoad = false;
        clearTimeout(settleTimer);
        await awaitLoadSettled(tab.id, settleMs || SETTLE_FALLBACK_MS);
      }
      settleMs = 0;
      lifecycleLog('generation_observe', { caller: 'START_or_OBSERVE', oldGeneration: state.generation, newGeneration: state.generation + 1,
        taskId: (command.type === 'START' ? undefined : state.taskId?.slice(0, 8)), tabId: tab.id, url: new URL(tab.url).origin });
      state = { status: 'observing', taskId: command.type === 'START' ? crypto.randomUUID() : state.taskId,
        tabId: tab.id, windowId: tab.windowId, origin: new URL(tab.url).origin,
        observationId: crypto.randomUUID(), generation: state.generation + 1 };
      lifecycleStateLog('observation_launched', state);
      await persist();
      launch({ ...state });
    }
    return { ok: true, state };
  }).then(reply).catch(() => reply({ ok: false, error: 'CAPTURE_FAILED', state }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { void serial(async () => { if (state.tabId === tabId) await pause('STOPPED', 'stopped'); }); });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading' || change.url) void serial(async () => {
  lifecycleLog('tabs_onUpdated', { tabId, status: change.status, urlChanged: !!change.url, taskTabId: state.tabId, taskStatus: state.status });
  if (state.tabId === tabId && state.status !== 'stopped') {
    // The pause may come from an ACT navigation — the action's own click —
    // and not only from a capture. Arm the same bounded settlement the capture
    // path uses, so the recovery OBSERVE photographs the settled document
    // instead of racing its last document swap.
    if (!awaitingLoad) {
      awaitingLoad = true;
      settleMs = SETTLE_FALLBACK_MS;
      settleTimer = setTimeout(() => { awaitingLoad = false; }, settleMs);
    }
    await pause('PAGE_CHANGED', 'paused',
      pageChangedDetail('PAGE_CHANGED_NAVIGATION', emptyMutationSummary(), undefined, undefined, 'The tab navigated while its capture was active.'));
  }
}); });
chrome.tabs.onActivated.addListener(info => { void serial(async () => {
  lifecycleLog('tabs_onActivated', { activatedTabId: info.tabId, windowId: info.windowId, taskTabId: state.tabId, taskStatus: state.status });
  if (state.tabId !== undefined && state.windowId === info.windowId && state.tabId !== info.tabId) await pause('PAGE_CHANGED', 'paused',
    pageChangedDetail('PAGE_CHANGED_NAVIGATION', emptyMutationSummary(), undefined, undefined, 'The active tab changed while its capture was active.'));
}); });

import { PanelCommandSchema, PageChangedSchema, TaskStateSchema, type ErrorCode, type TaskState } from '../contracts';
import { acceptsResult, initialState, invalidate, recover } from '../agent/lifecycle';
import { observeTab } from '../capture/observe';

let state = initialState();
let captureController: AbortController | undefined;
let captureDone: Promise<unknown> = Promise.resolve();
const publish = (message: unknown) => { void chrome.runtime.sendMessage(message).catch(() => {}); };
const persist = async () => {
  await chrome.storage.session.set({ task: state });
  publish({ type: 'STATE', state });
};
const ready = (async () => {
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = TaskStateSchema.safeParse((await chrome.storage.session.get('task')).task);
  state = saved.success ? recover(saved.data) : initialState();
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
async function pause(error: ErrorCode, status: 'paused' | 'failed' | 'stopped' = 'paused') {
  const tabId = state.tabId;
  state = invalidate(state, status, error);
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
  const capture = observeTab(tabId, windowId, origin, observationId, check, captureController.signal);
  captureDone = capture;
  void capture.then(observation => serial(async () => {
    check();
    state = { ...state, status: 'paused' };
    await persist();
    publish({ type: 'OBSERVATION', state, observation });
    // Raw images exist only in this call and an opt-in panel preview, never storage.
  })).catch(error => serial(async () => {
    if (acceptsResult(state, taskId, generation)) {
      if (error instanceof Error && error.message === 'PAGE_CHANGED') await pause('PAGE_CHANGED');
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
      if (sender.tab?.id === state.tabId && parsed.data.observationId === state.observationId) await pause('PAGE_CHANGED');
    });
    return;
  }
  if (!isPanel) return;
  const parsed = PanelCommandSchema.safeParse(raw);
  if (!parsed.success) { reply({ ok: false, error: 'INVALID_MESSAGE' }); return; }
  void serial(async () => {
    const command = parsed.data;
    if (command.type === 'STOP') await pause('STOPPED', 'stopped');
    if (command.type === 'START' || command.type === 'OBSERVE') {
      if (state.status === 'observing') return { ok: false, error: 'BUSY', state };
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined || !tab.url || !/^https?:/.test(tab.url)) return { ok: false, error: 'ACCESS_REQUIRED', state };
      if (command.type === 'OBSERVE' && (state.tabId !== tab.id || state.origin !== new URL(tab.url).origin)) return { ok: false, error: 'ACCESS_REQUIRED', state };
      await release(state.tabId);
      state = { status: 'observing', taskId: command.type === 'START' ? crypto.randomUUID() : state.taskId,
        tabId: tab.id, windowId: tab.windowId, origin: new URL(tab.url).origin,
        observationId: crypto.randomUUID(), generation: state.generation + 1 };
      await persist();
      launch({ ...state });
    }
    return { ok: true, state };
  }).then(reply).catch(() => reply({ ok: false, error: 'CAPTURE_FAILED', state }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { void serial(async () => { if (state.tabId === tabId) await pause('STOPPED', 'stopped'); }); });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading' || change.url) void serial(async () => {
  if (state.tabId === tabId && state.status !== 'stopped') await pause('PAGE_CHANGED');
}); });
chrome.tabs.onActivated.addListener(info => { void serial(async () => {
  if (state.tabId !== undefined && state.windowId === info.windowId && state.tabId !== info.tabId) await pause('PAGE_CHANGED');
}); });

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/dom/observe', () => ({ candidates: 'input,button,a[href]', collect: vi.fn((_observationId, _documentId, _revision, refs: Map<string, unknown>) => {
  const reviewed = (globalThis as typeof globalThis & { __reviewedControl?: unknown }).__reviewedControl;
  if (reviewed) refs.set('obs_e1', reviewed);
  return { elements: reviewed ? [{ id: 'obs_e1', bounds: { x: 0, y: 0, width: 100, height: 30 } }] : [] };
}) }));
let listener: (command: object, sender: object, reply: (value?: unknown) => void) => void;
const bounds = () => ({ x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 });
const element = () => ({ nodeType: 1, parentElement: null, childNodes: [], contains: (_node?: unknown) => false,
  closest: () => null, matches: () => false, querySelector: () => null, getBoundingClientRect: bounds });
const handlers = new Map<string, Array<() => void>>();
const fire = (event: string) => { for (const handler of handlers.get(event) ?? []) handler(); };
const sendMessage = vi.fn().mockResolvedValue(undefined);
let observerConstructed = 0;
const command = (type: string, extra: object = {}) => {
  let result: unknown;
  listener(type === 'RELEASE' ? { type } : { type, observationId: 'obs', ...extra }, { id: 'extension' }, value => { result = value; });
  return result;
};
const act = () => command('ACT', { action: { type: 'click', target: 'obs_e1' } });
beforeEach(async () => {
  vi.resetModules(); handlers.clear(); sendMessage.mockClear(); sendMessage.mockResolvedValue(undefined); observerConstructed = 0;
  vi.stubGlobal('__sih26Installed', undefined);
  vi.stubGlobal('innerWidth', 800); vi.stubGlobal('innerHeight', 600); vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('scrollX', 0); vi.stubGlobal('scrollY', 0);
  vi.stubGlobal('visualViewport', undefined);
  vi.stubGlobal('location', { href: 'https://example.test/form' });
  vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'visible', opacity: '1' }));
  vi.stubGlobal('__reviewedControl', element());
  vi.stubGlobal('window', { addEventListener: (event: string, callback: () => void) => {
    handlers.set(event, [...(handlers.get(event) ?? []), callback]);
  } });
  vi.stubGlobal('document', { documentElement: {}, body: {}, querySelectorAll: () => [], getElementsByTagName: () => [] });
  vi.stubGlobal('Node', { ELEMENT_NODE: 1 });
  vi.stubGlobal('MutationObserver', class {
    constructor() { observerConstructed++; }
    observe() {}
    takeRecords() { return []; }
  });
  vi.stubGlobal('chrome', { runtime: { id: 'extension', sendMessage, onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } });
  await import('../../src/dom/content');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// The content script no longer watches the DOM. A live application mutates
// constantly — counters, badges, re-renders, lazy images — and none of it means
// the captured pixels stopped describing the page.
describe('page churn no longer retires an observation', () => {
  it('installs no MutationObserver at all', () => {
    command('COLLECT');
    expect(observerConstructed).toBe(0);
  });
  it.each(['resize', 'scroll', 'input', 'change', 'animationstart', 'transitionrun'])(
    'does not report %s as a page change', event => {
      command('COLLECT');
      fire(event);
      expect(sendMessage).not.toHaveBeenCalled();
    });
  it('does not report a viewport change on its own', () => {
    command('COLLECT');
    vi.stubGlobal('innerWidth', 900); fire('resize');
    vi.stubGlobal('innerHeight', 300); fire('resize');
    expect(sendMessage).not.toHaveBeenCalled();
    // The capture check is what compares the viewport, and it still answers.
    expect(command('CHECK')).toMatchObject({ snapshot: expect.anything(), stability: expect.anything() });
  });
  it('keeps answering CHECK with a snapshot after ordinary churn', () => {
    command('PREPARE_CAPTURE'); command('COLLECT');
    fire('scroll'); fire('resize'); fire('input');
    const checked = command('CHECK') as { snapshot?: unknown; stability?: { url: string }; error?: string };
    expect(checked.error).toBeUndefined();
    expect(checked.stability?.url).toBe('https://example.test/form');
  });
});

// Navigation is the one thing the page itself can still report, because the
// document the screenshots describe no longer exists.
describe('navigation still retires an observation', () => {
  it.each(['popstate', 'hashchange', 'pagehide'])('reports %s as a navigation', event => {
    command('COLLECT');
    fire(event);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'PAGE_CHANGED', observationId: 'obs',
      detail: expect.objectContaining({ code: 'PAGE_CHANGED', cause: 'PAGE_CHANGED_NAVIGATION' }),
    }));
  });
  it('fails the capture check when navigation happened mid-capture', () => {
    command('PREPARE_CAPTURE'); command('COLLECT');
    fire('hashchange');
    // Nothing is published mid-capture; the check is where it surfaces.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(command('CHECK')).toMatchObject({ error: 'PAGE_CHANGED', detail: { cause: 'PAGE_CHANGED_NAVIGATION' } });
  });
  it('refuses an action once the page has navigated', () => {
    command('COLLECT');
    fire('popstate');
    expect(act()).toMatchObject({ error: 'PAGE_CHANGED' });
  });
});

describe('capture bookkeeping', () => {
  it('reports a stability snapshot beside the DOM snapshot', () => {
    const response = command('COLLECT') as { stability: { url: string; viewportWidth: number; interactiveElementCount: number } };
    expect(response.stability).toMatchObject({ url: 'https://example.test/form', viewportWidth: 800, interactiveElementCount: 1 });
  });
  it('clears its element map on RELEASE', () => {
    command('COLLECT');
    command('RELEASE');
    expect(act()).toMatchObject({ error: 'PAGE_CHANGED' });
  });
});

// `back` is the model's wrong-destination recovery: a browser history step
// that never addresses an element. It deliberately bypasses the element map —
// even a stale or empty map must not stand between the recovery and the
// navigation it requests.
describe('the back action', () => {
  it('performs one history step back without touching any element', () => {
    command('COLLECT');
    const back = vi.fn();
    vi.stubGlobal('history', { length: 5, back });
    expect(command('ACT', { action: { type: 'back' } })).toEqual({ ok: true });
    expect(back).toHaveBeenCalledTimes(1);
  });
  it('fails safely when there is no history to go back to', () => {
    command('COLLECT');
    const back = vi.fn();
    vi.stubGlobal('history', { length: 1, back });
    expect(command('ACT', { action: { type: 'back' } })).toEqual({ error: 'ACTION_FAILED' });
    expect(back).not.toHaveBeenCalled();
  });
});

// The `key` action is a keyboard action, not a click: it lands on whatever the
// reviewed flow left focused. A constructed KeyboardEvent is untrusted — the
// browser performs no default action for it and Chrome leaves keyCode/charCode
// at 0 — so the executor must fill the codes page scripts read and perform the
// one default action a real Enter has on a form control: implicit submission.
describe('the key action', () => {
  interface CapturedEvent { type: string; init: Record<string, unknown>; defaultPrevented: boolean }
  let events: CapturedEvent[];
  let submitted: number;
  const keyboardStub = vi.fn();
  const focusStub = (preventDefaultKeydown = false) => {
    submitted = 0;
    const form = { requestSubmit: () => { submitted++; } };
    const focused = {
      dispatchEvent: (event: { type: string; defaultPrevented: boolean }) => {
        if (preventDefaultKeydown && event.type === 'keydown') event.defaultPrevented = true;
        return true;
      },
      closest: () => form,
    };
    vi.stubGlobal('KeyboardEvent', keyboardStub as unknown as typeof KeyboardEvent);
    vi.stubGlobal('document', { documentElement: {}, querySelectorAll: () => [], getElementsByTagName: () => [],
      activeElement: focused });
  };
  beforeEach(() => {
    events = []; submitted = 0;
    // The file-level afterEach calls vi.restoreAllMocks(), which resets the
    // implementation of every plain vi.fn() — including this one — after each
    // test. Re-install the implementation here so every test starts with it.
    keyboardStub.mockReset();
    keyboardStub.mockImplementation(function (this: { defaultPrevented: boolean }, type: string, init: Record<string, unknown> = {}) {
      const event = { type, init, defaultPrevented: false };
      events.push(event);
      return event;
    });
    command('COLLECT');
  });
  it('dispatches the full key sequence with the codes page scripts read', () => {
    focusStub();
    expect(command('ACT', { action: { type: 'key', key: 'Enter' } })).toEqual({ ok: true });
    expect(events.map(event => event.type)).toEqual(['keydown', 'keypress', 'keyup']);
    expect(events.every(event => event.init.key === 'Enter' && event.init.keyCode === 13)).toBe(true);
    expect(events.every(event => event.init.bubbles === true && event.init.cancelable === true)).toBe(true);
  });
  it('performs the implicit submission Enter has on a focused form control', () => {
    focusStub();
    expect(command('ACT', { action: { type: 'key', key: 'Enter' } })).toEqual({ ok: true });
    expect(submitted).toBe(1);
  });
  it('leaves submission to a page that handles the keydown itself', () => {
    focusStub(true);
    expect(command('ACT', { action: { type: 'key', key: 'Enter' } })).toEqual({ ok: true });
    expect(submitted).toBe(0);
    // Chrome suppresses the keypress of a keydown the page claimed — keypress
    // is part of keydown's default processing — while keyup still arrives.
    // The executor mirrors that exactly: the claiming page reads the filled
    // codes on its keydown and no default action is performed a second time.
    expect(events.map(event => event.type)).toEqual(['keydown', 'keyup']);
  });
});

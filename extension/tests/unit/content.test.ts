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

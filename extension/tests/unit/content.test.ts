import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/dom/observe', () => ({ collect: vi.fn().mockReturnValue({}) }));
let listener: (command: object, sender: object, reply: () => void) => void;
let mutated: () => void;
const handlers = new Map<string, () => void>();
const sendMessage = vi.fn().mockResolvedValue(undefined);
const command = (type: string) => listener(type === 'RELEASE' ? { type } : { type, observationId: 'obs' }, { id: 'extension' }, () => {});
beforeEach(async () => {
  vi.resetModules(); handlers.clear(); sendMessage.mockClear(); sendMessage.mockResolvedValue(undefined);
  vi.stubGlobal('__sih26Installed', undefined);
  vi.stubGlobal('innerWidth', 800); vi.stubGlobal('innerHeight', 600); vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('visualViewport', undefined);
  vi.stubGlobal('window', { addEventListener: (event: string, callback: () => void) => handlers.set(event, callback) });
  vi.stubGlobal('document', { documentElement: {}, querySelectorAll: () => [] });
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { mutated = callback; }
    observe() {}
    takeRecords() { return []; }
  });
  vi.stubGlobal('chrome', { runtime: { id: 'extension', sendMessage, onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } } });
  await import('../../src/dom/content');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('capture viewport tracking', () => {
  it('ignores a resize event only when the viewport did not change', () => {
    command('COLLECT'); handlers.get('resize')!();
    expect(sendMessage).not.toHaveBeenCalled();
    vi.stubGlobal('innerWidth', 900); handlers.get('resize')!();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'PAGE_CHANGED', observationId: 'obs' });
  });
  it('permits the debugging notice to restore the original size without discarding results', () => {
    command('PREPARE_CAPTURE');
    vi.stubGlobal('innerHeight', 544); handlers.get('resize')!();
    command('COLLECT'); command('FINISH_CAPTURE');
    vi.stubGlobal('innerHeight', 600); handlers.get('resize')!();
    expect(sendMessage).not.toHaveBeenCalled();
    vi.stubGlobal('innerHeight', 700); handlers.get('resize')!();
    expect(sendMessage).toHaveBeenCalledOnce();
  });
  it.each(['input', 'scroll'])('never suppresses user %s during capture', event => {
    command('PREPARE_CAPTURE'); command('COLLECT');
    handlers.get(event)!();
    expect(sendMessage).toHaveBeenCalledOnce();
  });
  it('preserves the original viewport across Scan again while the notice is still visible', () => {
    command('PREPARE_CAPTURE');
    vi.stubGlobal('innerHeight', 544); handlers.get('resize')!();
    command('COLLECT'); command('FINISH_CAPTURE'); command('RELEASE');
    command('PREPARE_CAPTURE'); command('COLLECT'); command('FINISH_CAPTURE');
    vi.stubGlobal('innerHeight', 600); handlers.get('resize')!();
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it('never suppresses DOM mutations during capture', () => {
    command('PREPARE_CAPTURE'); command('COLLECT'); mutated();
    expect(sendMessage).toHaveBeenCalledOnce();
  });
  it('tracks notice restoration across a zoom change between scans', () => {
    command('PREPARE_CAPTURE');
    vi.stubGlobal('innerHeight', 544); handlers.get('resize')!();
    command('COLLECT'); command('FINISH_CAPTURE'); command('RELEASE');
    vi.stubGlobal('innerWidth', 640); vi.stubGlobal('innerHeight', 435); vi.stubGlobal('devicePixelRatio', 1.25); handlers.get('resize')!();
    command('PREPARE_CAPTURE'); command('COLLECT'); command('FINISH_CAPTURE');
    vi.stubGlobal('innerHeight', 480); handlers.get('resize')!();
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it('does not allow a delayed resize exception after the notice deadline', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    command('PREPARE_CAPTURE');
    vi.stubGlobal('innerHeight', 544); handlers.get('resize')!();
    command('COLLECT'); command('FINISH_CAPTURE');
    now.mockReturnValue(10_001);
    vi.stubGlobal('innerHeight', 600); handlers.get('resize')!();
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});

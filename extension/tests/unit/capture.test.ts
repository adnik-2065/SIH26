import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeTab } from '../../src/capture/observe';

const snapshot = { observationId: 'obs_1', documentId: 'doc_1', revision: 0, origin: 'https://example.test',
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 250, devicePixelRatio: 1, visualScale: 1, offsetX: 0, offsetY: 0 },
  elements: [], hiddenCount: 0, truncated: false };
function png(width = 800, height = 1800) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return btoa(String.fromCharCode(...bytes));
}
const sendMessage = vi.fn(), query = vi.fn(), attach = vi.fn(), detach = vi.fn(), sendCommand = vi.fn();
const addListener = vi.fn(), removeListener = vi.fn(), captureVisibleTab = vi.fn();
const executeScript = vi.fn(), insertCSS = vi.fn(), removeCSS = vi.fn();
beforeEach(() => {
  query.mockResolvedValue([{ id: 1, url: 'https://example.test/form' }]);
  sendMessage.mockImplementation(async (_tab, command) => command.type === 'PREPARE_CAPTURE' ? { ok: true } : snapshot);
  attach.mockResolvedValue(undefined); detach.mockResolvedValue(undefined);
  executeScript.mockResolvedValue([]); insertCSS.mockResolvedValue(undefined); removeCSS.mockResolvedValue(undefined);
  sendCommand.mockImplementation(async (_target, method: string) => method === 'Page.getLayoutMetrics'
    ? { cssContentSize: { width: 800, height: 1800 } } : { data: png() });
  vi.stubGlobal('chrome', { tabs: { query, sendMessage, captureVisibleTab },
    scripting: { executeScript, insertCSS, removeCSS },
    debugger: { attach, detach, sendCommand, onDetach: { addListener, removeListener } } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); vi.useRealTimers(); });

describe('non-scrolling full-page capture', () => {
  it('captures the full document once without any scrolling or visible-tab capture', async () => {
    const result = await observeTab(1, 1, snapshot.origin, 'obs_1', () => {});
    expect(result.dom).toEqual(snapshot);
    expect(result.imageHeight).toBe(1800);
    expect(result.captureBounds).toEqual({ x: 0, y: 0, width: 800, height: 1800 });
    expect(sendCommand.mock.calls.map(([, method]) => method)).toEqual(['Page.getLayoutMetrics', 'Emulation.setDeviceMetricsOverride', 'Page.captureScreenshot', 'Emulation.clearDeviceMetricsOverride']);
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width: 800, height: 1800, scale: 1 },
    });
    expect(sendMessage.mock.calls.map(([, command]) => command.type)).toEqual(['PREPARE_CAPTURE', 'COLLECT', 'CHECK', 'FINISH_CAPTURE']);
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledOnce();
    expect(insertCSS).not.toHaveBeenCalled();
  });
  it('reserves classic scrollbar space only during capture and removes the exact stylesheet', async () => {
    executeScript.mockResolvedValueOnce([]).mockResolvedValueOnce([{ result: true }]);
    await observeTab(1, 1, snapshot.origin, 'obs_1', () => {});
    expect(insertCSS).toHaveBeenCalledOnce();
    expect(insertCSS).toHaveBeenCalledWith({ target: { tabId: 1 }, css: ':root { scrollbar-gutter: stable !important; }', origin: 'USER' });
    expect(removeCSS).toHaveBeenCalledWith(insertCSS.mock.calls[0][0]);
    expect(removeCSS.mock.invocationCallOrder[0]).toBeGreaterThan(detach.mock.invocationCallOrder[0]);
  });
  it.each([
    { clientWidth: 785, gutter: 'auto', reserve: true },
    { clientWidth: 800, gutter: 'auto', reserve: false },
    { clientWidth: 785, gutter: 'stable', reserve: false },
    { clientWidth: 770, gutter: 'stable both-edges', reserve: false },
  ])('preserves existing scrollbar layout: $clientWidth px, $gutter', async ({ clientWidth, gutter, reserve }) => {
    vi.stubGlobal('innerWidth', 800);
    vi.stubGlobal('document', { documentElement: { clientWidth } });
    vi.stubGlobal('getComputedStyle', () => ({ scrollbarGutter: gutter }));
    executeScript.mockImplementation(async ({ func }: { func?: () => boolean }) => func ? [{ result: func() }] : []);
    await observeTab(1, 1, snapshot.origin, 'obs_1', () => {});
    expect(insertCSS).toHaveBeenCalledTimes(reserve ? 1 : 0);
    expect(removeCSS).toHaveBeenCalledTimes(reserve ? 1 : 0);
  });
  it.each(['failure', 'stop'])('removes the scrollbar reservation on capture %s', async reason => {
    const controller = new AbortController();
    executeScript.mockResolvedValueOnce([]).mockResolvedValueOnce([{ result: true }]);
    sendCommand.mockImplementation(async (_target, method) => {
      if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 800, height: 1800 } };
      if (method === 'Page.captureScreenshot') {
        if (reason === 'stop') { controller.abort(); return new Promise(() => {}); }
        throw new Error('Capture failed');
      }
      return {};
    });
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {}, controller.signal)).rejects.toThrow();
    expect(detach).toHaveBeenCalledOnce();
    expect(removeCSS).toHaveBeenCalledWith(insertCSS.mock.calls[0][0]);
  });
  it('rejects real changes during capture and always detaches', async () => {
    sendMessage.mockImplementation(async (_tab, command) => command.type === 'PREPARE_CAPTURE' ? { ok: true } : command.type === 'CHECK' ? { ...snapshot, revision: 1 } : snapshot);
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {})).rejects.toThrow('PAGE_CHANGED');
    expect(detach).toHaveBeenCalledOnce();
  });
  it('does not touch a different active tab', async () => {
    query.mockResolvedValue([{ id: 2, url: 'https://example.test' }]);
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {})).rejects.toThrow('PAGE_CHANGED');
    expect(attach).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });
  it('does not detach someone else or fall back to scrolling if attach fails', async () => {
    attach.mockRejectedValue(new Error('Already attached'));
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {})).rejects.toThrow('Already attached');
    expect(detach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });
  it('detaches on screenshot failure', async () => {
    sendCommand.mockRejectedValue(new Error('Capture failed'));
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {})).rejects.toThrow();
    expect(detach).toHaveBeenCalledOnce();
  });
  it('bounds allocation before requesting a huge screenshot', async () => {
    sendCommand.mockResolvedValue({ cssContentSize: { width: 800, height: 100000 } });
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {})).rejects.toThrow('CAPTURE_TOO_LARGE');
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledOnce();
  });
  it('rejects invalid PNG dimensions', async () => {
    sendCommand.mockImplementation(async (_target, method) => method === 'Page.getLayoutMetrics'
      ? { cssContentSize: { width: 800, height: 1800 } } : { data: png(600) });
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {})).rejects.toThrow('CAPTURE_FAILED');
    expect(detach).toHaveBeenCalledOnce();
  });
  it('Stop interrupts a pending screenshot immediately and discards its late result', async () => {
    const controller = new AbortController();
    let finish!: (value: object) => void;
    sendCommand.mockImplementation(async (_target, method) => {
      if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 800, height: 1800 } };
      if (method !== 'Page.captureScreenshot') return {};
      controller.abort();
      return new Promise(resolve => { finish = resolve; });
    });
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {}, controller.signal)).rejects.toThrow('STOPPED');
    expect(detach).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls.map(([, command]) => command.type)).toEqual(['PREPARE_CAPTURE', 'COLLECT']);
    finish({ data: png() });
  });
  it('cleans up a late attachment after Stop', async () => {
    const controller = new AbortController();
    attach.mockImplementation(async () => { controller.abort(); });
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {}, controller.signal)).rejects.toThrow('STOPPED');
    expect(detach).toHaveBeenCalledOnce();
    expect(sendCommand).not.toHaveBeenCalled();
  });
  it('releases a stalled capture at the deadline', async () => {
    vi.useFakeTimers();
    sendCommand.mockReturnValue(new Promise(() => {}));
    const result = observeTab(1, 1, snapshot.origin, 'obs_1', () => {});
    const rejected = expect(result).rejects.toThrow('CAPTURE_FAILED');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(detach).toHaveBeenCalledOnce();
  });
  it('honors browser cancellation without detaching a later session', async () => {
    sendCommand.mockImplementation(async () => {
      addListener.mock.calls[0][0]({ tabId: 1 }, 'canceled_by_user');
      return new Promise(() => {});
    });
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {})).rejects.toThrow('CAPTURE_FAILED');
    expect(detach).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledOnce();
  });
});

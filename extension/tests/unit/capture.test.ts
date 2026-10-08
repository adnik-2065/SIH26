import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeTab } from '../../src/capture/observe';
import { CaptureError, captureErrorCategory } from '../../src/capture/errors';
import { captureTiles } from '../../src/capture/tiles';

const snapshot = { observationId: 'obs_1', documentId: 'doc_1', revision: 0, origin: 'https://example.test',
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 250, devicePixelRatio: 1, visualScale: 1, offsetX: 0, offsetY: 0 },
  elements: [], hiddenCount: 0, truncated: false };
const stability = { url: 'https://example.test/form', documentId: 'doc_1', documentWidth: 800, documentHeight: 1800,
  scrollWidth: 800, scrollHeight: 1800, viewportWidth: 800, viewportHeight: 600, scrollX: 0, scrollY: 250,
  totalElementCount: 20, interactiveElementCount: 0 };
const mutationSummary = { total: 0, ignored: 0, significant: 0, categories: {} };
const response = (dom = snapshot, stable = stability, mutations = mutationSummary) => ({ snapshot: dom, stability: stable, mutations });
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
  sendMessage.mockImplementation(async (_tab, command) => command.type === 'PREPARE_CAPTURE' ? { ok: true } : response());
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
    expect(insertCSS).toHaveBeenCalledOnce();
    expect(insertCSS.mock.calls[0][0].css).toContain('animation-play-state: paused');
    expect(removeCSS).toHaveBeenCalledWith(insertCSS.mock.calls[0][0]);
  });
  it('reserves classic scrollbar space only during capture and removes the exact stylesheet', async () => {
    executeScript.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ result: true }]);
    await observeTab(1, 1, snapshot.origin, 'obs_1', () => {});
    expect(insertCSS).toHaveBeenCalledTimes(2);
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
    executeScript.mockImplementation(async ({ func }: { func?: () => boolean }) => func && func.name !== 'waitForStableViewport' ? [{ result: func() }] : []);
    await observeTab(1, 1, snapshot.origin, 'obs_1', () => {});
    expect(insertCSS).toHaveBeenCalledTimes(reserve ? 2 : 1);
    expect(removeCSS).toHaveBeenCalledTimes(reserve ? 2 : 1);
  });
  it.each(['failure', 'stop'])('removes the scrollbar reservation on capture %s', async reason => {
    const controller = new AbortController();
    executeScript.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ result: true }]);
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
    expect(removeCSS).toHaveBeenCalledWith(insertCSS.mock.calls[1][0]);
  });
  it('rejects a major document-size change during capture and always detaches', async () => {
    sendMessage.mockImplementation(async (_tab, command) => command.type === 'PREPARE_CAPTURE' ? { ok: true }
      : command.type === 'CHECK' ? response(snapshot, { ...stability, documentHeight: 4000, scrollHeight: 4000 }) : response());
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {})).rejects.toThrow('PAGE_CHANGED');
    expect(detach).toHaveBeenCalledOnce();
  });
  it('does not touch a different active tab, and says the tab changed', async () => {
    query.mockResolvedValue([{ id: 2, url: 'https://example.test' }]);
    // The coarse task error is still PAGE_CHANGED; the detail names the tab.
    const failure = await observeTab(1, 1, snapshot.origin, 'obs_1', () => {}).catch(error => error as CaptureError);
    expect(failure).toBeInstanceOf(CaptureError);
    expect((failure as CaptureError).detail).toMatchObject({ code: 'CAPTURE_ACTIVE_TAB_CHANGED', stage: 'CAPTURE',
      context: { expectedTabId: 1, activeTabId: 2 } });
    expect(captureErrorCategory((failure as CaptureError).detail.code)).toBe('PAGE_CHANGED');
    expect(attach).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });
  it('does not detach someone else or fall back to scrolling if attach fails', async () => {
    attach.mockRejectedValue(new Error('Already attached'));
    const failure = await observeTab(1, 1, snapshot.origin, 'obs_1', () => {}).catch(error => error as CaptureError);
    expect((failure as CaptureError).detail).toMatchObject({ code: 'CAPTURE_DEBUGGER_ATTACH_FAILED',
      context: { errorMessage: 'Already attached' } });
    expect(detach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });
  it('detaches on screenshot failure', async () => {
    sendCommand.mockRejectedValue(new Error('Capture failed'));
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {})).rejects.toThrow();
    expect(detach).toHaveBeenCalledOnce();
  });
  it.each([{ width: 1400, height: 40000, dpr: 1 }, { width: 1400, height: 18000, dpr: 2 }, { width: 800, height: 100000, dpr: 1.25 }])(
    'captures every part of a $width × $height page at DPR $dpr with bounded allocations', async ({ width, height, dpr }) => {
      const dom = { ...snapshot, viewport: { ...snapshot.viewport, devicePixelRatio: dpr } };
      const dimensions = { ...stability, documentWidth: width, documentHeight: height, scrollWidth: width, scrollHeight: height };
      sendMessage.mockImplementation(async (_tab, command) => command.type === 'PREPARE_CAPTURE' ? { ok: true } : response(dom, dimensions));
      sendCommand.mockImplementation(async (_target, method, params) => method === 'Page.getLayoutMetrics'
        ? { cssContentSize: { width, height } } : method === 'Page.captureScreenshot'
          ? { data: png(Math.round(params.clip.width * dpr), Math.round(params.clip.height * dpr)) } : {});
      const onTile = vi.fn().mockResolvedValue(undefined);
      const result = await observeTab(1, 1, snapshot.origin, 'obs_1', () => {}, undefined, onTile);
      expect(result.imageWidth).toBe(width * dpr);
      expect(result.imageHeight).toBe(height * dpr);
      expect(result.tileCount).toBeGreaterThan(1);
      const tiles = onTile.mock.calls.map(([tile]) => tile);
      expect(new Set(tiles.map(tile => tile.height)).size).toBe(1);
      expect(tiles[0].height).toBe(dom.viewport.height * dpr);
      expect(tiles[0].start).toBe(0);
      expect(tiles.at(-1).end).toBe(result.imageHeight);
      for (const [index, tile] of tiles.entries()) {
        expect(tile.width * tile.height).toBeLessThanOrEqual(8_000_000);
        expect(tile.y).toBeLessThanOrEqual(tile.start);
        expect(tile.y + tile.height).toBeGreaterThanOrEqual(tile.end);
        if (index) {
          expect(tile.start).toBe(tiles[index - 1].end);
          expect(tile.y).toBeLessThan(tiles[index - 1].y + tiles[index - 1].height);
        }
      }
      expect(captureVisibleTab).not.toHaveBeenCalled();
      expect(detach).toHaveBeenCalledOnce();
    });
  it('bounds unsupported width before requesting a screenshot', async () => {
    sendCommand.mockResolvedValue({ cssContentSize: { width: 40000, height: 1000 } });
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {})).rejects.toThrow('CAPTURE_DIMENSION_LIMIT_EXCEEDED');
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledOnce();
  });
  it('does not continue a long capture after Stop between tiles', async () => {
    const controller = new AbortController();
    sendCommand.mockImplementation(async (_target, method, params) => method === 'Page.getLayoutMetrics'
      ? { cssContentSize: { width: 800, height: 100000 } } : method === 'Page.captureScreenshot'
        ? { data: png(params.clip.width, params.clip.height) } : {});
    const onTile = vi.fn().mockImplementation(async () => controller.abort());
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {}, controller.signal, onTile)).rejects.toThrow('STOPPED');
    expect(onTile).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls.some(([, command]) => command.type === 'FINISH_CAPTURE')).toBe(false);
    expect(detach).toHaveBeenCalledOnce();
  });
  it.each([
    // Each protective limit reports which one fired and the value it saw.
    ['a page wider than the maximum side', 40_000, 1_800, 'CAPTURE_DIMENSION_LIMIT_EXCEEDED', { maximumSide: 32_767, width: 40_000 }],
    ['a pixel count over the maximum', 20_000, 2_000, 'CAPTURE_PIXEL_LIMIT_EXCEEDED', { maximumPixels: 32_000_000, pixels: 40_000_000 }],
  ])('refuses %s', async (_label, width, height, code, context) => {
    sendCommand.mockImplementation(async (_target, method) => method === 'Page.getLayoutMetrics'
      ? { cssContentSize: { width, height } } : { data: png(width, height) });
    const failure = await observeTab(1, 1, snapshot.origin, 'obs_1', () => {}).catch(error => error as CaptureError);
    expect((failure as CaptureError).detail).toMatchObject({ code, stage: 'CAPTURE' });
    expect((failure as CaptureError).detail.context).toMatchObject(context);
    expect(captureErrorCategory((failure as CaptureError).detail.code)).toBe('CAPTURE_TOO_LARGE');
  });
  it('rejects invalid PNG dimensions, and reports what it expected', async () => {
    sendCommand.mockImplementation(async (_target, method) => method === 'Page.getLayoutMetrics'
      ? { cssContentSize: { width: 800, height: 1800 } } : { data: png(600) });
    const failure = await observeTab(1, 1, snapshot.origin, 'obs_1', () => {}).catch(error => error as CaptureError);
    expect((failure as CaptureError).detail).toMatchObject({ code: 'CAPTURE_SCREENSHOT_INVALID', stage: 'CAPTURE' });
    expect((failure as CaptureError).detail.context).toMatchObject({ expectedWidth: 800, actualWidth: 600 });
    expect(captureErrorCategory((failure as CaptureError).detail.code)).toBe('CAPTURE_FAILED');
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
    // The per-command deadline is named, so a stall is distinguishable from a
    // refused command or an invalid screenshot.
    const rejected = expect(result).rejects.toThrow('CAPTURE_COMMAND_TIMEOUT');
    await vi.advanceTimersByTimeAsync(15_250);
    await rejected;
    expect(detach).toHaveBeenCalledOnce();
  });
  it('honors browser cancellation without detaching a later session', async () => {
    sendCommand.mockImplementation(async () => {
      addListener.mock.calls[0][0]({ tabId: 1 }, 'canceled_by_user');
      return new Promise(() => {});
    });
    await expect(observeTab(1, 1, snapshot.origin, 'obs_1', () => {})).rejects.toThrow('CAPTURE_DEBUGGER_DETACHED');
    expect(detach).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledOnce();
  });
});

describe('capture tile planning', () => {
  it('keeps ordinary pages in a single image and bounds extreme aspect ratios', () => {
    expect(captureTiles(800, 1800)).toEqual([{ y: 0, height: 1800, start: 0, end: 1800 }]);
    for (const width of [1, 1400, 32767]) for (const tile of captureTiles(width, 50000)) {
      expect(tile.height).toBeLessThanOrEqual(8192);
      expect(width * tile.height).toBeLessThanOrEqual(8_000_000);
    }
    expect(() => captureTiles(800, Number.MAX_SAFE_INTEGER)).toThrow('CAPTURE_PIXEL_LIMIT_EXCEEDED');
  });
});

import { z } from 'zod';
import { CaptureCheckResponseSchema, CaptureSnapshotResponseSchema, PageChangedDetailSchema,
  type CaptureObservation, type CaptureScope, type CaptureTile, type MutationSummary, type PageChangeReason } from '../contracts';
import { captureTiles } from './tiles';
import { compareCaptureStability, emptyMutationSummary, PageChangedError, pageChangedDetail } from './stability';
import { CaptureError, captureError, CAPTURE_LIMITS } from './errors';
import { lifecycleLog } from '../agent/lifecycle';

const LayoutSchema = z.object({
  cssContentSize: z.object({ width: z.number().positive().finite(), height: z.number().positive().finite() }),
  cssVisualViewport: z.object({ zoom: z.number().positive().finite().optional() }).optional(),
});
const ScreenshotSchema = z.object({ data: z.string().min(44).max(29_999_978).regex(/^[A-Za-z0-9+/]+={0,2}$/) });
const maxPixels = CAPTURE_LIMITS.maxPixels;
const maxSide = CAPTURE_LIMITS.maxSide;
const captureScrollbarCSS = ':root { scrollbar-gutter: stable !important; }';
const captureMotionCSS = '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }';

// Read PNG dimensions without decompressing another full-page bitmap in the
// background worker. Actual image decoding belongs to the panel.
function pngSize(encoded: string) {
  const bytes = Uint8Array.from(atob(encoded.slice(0, 44)), character => character.charCodeAt(0));
  if ([137, 80, 78, 71, 13, 10, 26, 10].some((byte, i) => bytes[i] !== byte) ||
    String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') {
    throw captureError('CAPTURE_SCREENSHOT_INVALID', 'The screenshot did not arrive as a PNG.',
      { encodedBytes: encoded.length }, 'PNG signature or IHDR header missing');
  }
  const header = new DataView(bytes.buffer);
  return { width: header.getUint32(16), height: header.getUint32(20) };
}

// Where a capture stood when it ended. `phase` is the last fully collected
// state: COLLECT means the DOM snapshot and at least one screenshot were taken
// (a tile delivery was interrupted), CHECK means the screenshots were complete
// and only the final stability comparison was interrupted. The retry policy
// uses this to wait out an in-flight navigation instead of re-capturing blind.
export interface CaptureEndContext { phase: 'NONE' | 'COLLECT' | 'CHECK'; steps: string[]; signalAborted: boolean }

export async function observeTab(tabId: number, windowId: number, origin: string, observationId: string,
  check: () => void, signal?: AbortSignal,
  onTile: (tile: CaptureTile, index: number, count: number) => Promise<void> = async () => {},
  onEnd?: (context: CaptureEndContext) => void, scope: CaptureScope = 'viewport'): Promise<CaptureObservation> {
  const target = { tabId };
  const steps: string[] = [];
  const instrument: { phase: 'NONE' | 'COLLECT' | 'CHECK' } = { phase: 'NONE' };
  let attached = false;
  let scrollbarReserved = false;
  let motionPaused = false;
  let captureUrl: string | undefined;
  let failure: Error | undefined;
  let rejectInterrupted!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  // An abort can arrive while attach() is still pending.
  void interrupted.catch(() => {});
  // Each interruption keeps the reason that fired it, instead of every one of
  // them arriving at the panel as CAPTURE_FAILED.
  const interrupt = (error: Error) => { failure ??= error; rejectInterrupted(failure); };
  const abort = () => interrupt(new Error('STOPPED'));
  const detached = (source: chrome.debugger.Debuggee) => {
    if (source.tabId === tabId && attached) {
      attached = false;
      lifecycleLog('debugger_onDetach', { tabId, elapsedMs: Math.round(performance.now() - started) });
      interrupt(captureError('CAPTURE_DEBUGGER_DETACHED', 'The debugger session ended before the capture finished.',
        { tabId, elapsedMs: Math.round(performance.now() - started) },
        'another client took the debugger, or the user dismissed the notice'));
    }
  };
  const current = () => { if (failure) throw failure; if (signal?.aborted) throw new Error('STOPPED'); check(); };
  const pageChanged = (reason: PageChangeReason, mutations: MutationSummary = emptyMutationSummary()) =>
    new PageChangedError(pageChangedDetail(reason, mutations));
  // chrome.tabs and chrome.scripting throw raw browser errors when the frame
  // they address disappears mid-navigation ("Cannot access contents of url",
  // "Receiving end does not exist", "No frame with given id"). Idle, an
  // inaccessible frame means a genuinely restricted page — a real capture
  // failure. While the tab still reports 'loading', the same error means the
  // document was replaced under the capture: the retryable race. Evidence
  // taken at throw time is what tells the two apart, so only an
  // in-flight-navigation ending is re-labelled; everything else keeps its
  // original meaning in the background's classifier.
  const captureStep = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof CaptureError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      let navigationInFlight: boolean;
      try { navigationInFlight = (await chrome.tabs.get(tabId)).status === 'loading'; }
      catch { navigationInFlight = true; }
      // Only the AMBIGUOUS family is re-labelled here. "Receiving end does not
      // exist", "message port closed", "No frame with given id" and "Cannot
      // find context" already carry an unambiguous navigation meaning in the
      // background classifier and propagate unchanged; a restricted page that
      // is simply not injectable keeps failing as CAPTURE_FAILED.
      if (navigationInFlight && /Cannot access contents of url|Frame no longer exists|Frame with given id was detached|Inspected target navigated|The tab was closed/i.test(message))
        throw captureError('CAPTURE_PAGE_CHANGED', 'The page navigated while the capture was working.',
          { errorMessage: message.slice(0, 160), navigationInFlight }, 'document replaced during capture');
      throw error;
    }
  };
  const active = async () => {
    current();
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id !== tabId || !tab.url || new URL(tab.url).origin !== origin) {
      throw captureError('CAPTURE_ACTIVE_TAB_CHANGED', 'The captured tab is no longer the active tab on its origin.',
        { expectedTabId: tabId, activeTabId: tab?.id ?? null, originMatches: tab?.url ? new URL(tab.url).origin === origin : false },
        'active tab or origin changed');
    }
    if (captureUrl && tab.url !== captureUrl) throw pageChanged('PAGE_CHANGED_NAVIGATION');
    captureUrl ??= tab.url;
    current();
  };
  const command = async (method: string, parameters?: object) => {
    current();
    // A long page can take longer than one screenshot, but a stalled command
    // still times out promptly. Stop also interrupts any command immediately.
    clearTimeout(deadline);
    deadline = setTimeout(() => interrupt(captureError('CAPTURE_COMMAND_TIMEOUT',
      `The browser did not answer ${method} within ${CAPTURE_LIMITS.commandTimeoutMs} ms.`,
      { method, timeoutMs: CAPTURE_LIMITS.commandTimeoutMs, elapsedMs: Math.round(performance.now() - started) },
      'per-command deadline')), CAPTURE_LIMITS.commandTimeoutMs);
    const result = await Promise.race([
      chrome.debugger.sendCommand(target, method, parameters).catch((error: unknown) => {
        throw captureError('CAPTURE_SCREENSHOT_FAILED', `The browser refused ${method}.`,
          { method, errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message.slice(0, 160) : undefined }, 'debugger command rejected');
      }), interrupted]);
    current();
    return result;
  };
  signal?.addEventListener('abort', abort, { once: true });
  let deadline = setTimeout(() => interrupt(captureError('CAPTURE_COMMAND_TIMEOUT',
    `A capture step did not finish within ${CAPTURE_LIMITS.commandTimeoutMs} ms.`,
    { timeoutMs: CAPTURE_LIMITS.commandTimeoutMs }, 'per-command deadline')), CAPTURE_LIMITS.commandTimeoutMs);
  const totalDeadline = setTimeout(() => interrupt(captureError('CAPTURE_TOTAL_TIMEOUT',
    `The capture did not finish within ${CAPTURE_LIMITS.totalTimeoutMs / 1000} seconds.`,
    { timeoutMs: CAPTURE_LIMITS.totalTimeoutMs }, 'total capture deadline')), CAPTURE_LIMITS.totalTimeoutMs);
  chrome.debugger.onDetach.addListener(detached);
  const started = performance.now();
  const capturedAt = Date.now();
  try {
    await active();
    // From here on the tab was verified present at this URL: an ending during
    // the steps below happened while this page was being photographed, which
    // is the window a mid-capture navigation lands in.
    steps.push('ACTIVE_URL');
    // Injection first preserves the existing user-granted activeTab boundary.
    await captureStep(() => chrome.scripting.executeScript({ target, files: ['content.js'] }));
    current();
    // The panel can be clicked while Chrome is still animating it open. Measure
    // the pre-notice viewport only after that animation has settled; otherwise
    // the panel's inset gets mistaken for part of the debugging notice.
    // A viewport exactly as the previous capture of this document settled it
    // has already stopped animating, and later rounds skip the wait. The size
    // is kept in the extension's isolated world, which the page cannot reach.
    await Promise.race([captureStep(() => chrome.scripting.executeScript({ target, func: async function waitForStableViewport() {
      const started = performance.now();
      const settled = globalThis as { sih26SettledViewport?: string };
      let last = `${innerWidth}:${innerHeight}:${devicePixelRatio}`, stableSince = started;
      const known = last === settled.sih26SettledViewport;
      while (!known && performance.now() - stableSince < 150 && performance.now() - started < 1500) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const next = `${innerWidth}:${innerHeight}:${devicePixelRatio}`;
        if (next !== last) { last = next; stableSince = performance.now(); }
      }
      settled.sih26SettledViewport = last;
    } })), interrupted]);
    current();
    const prepared = z.union([z.object({ ok: z.literal(true) }).strict(),
      z.object({ error: z.literal('PAGE_CHANGED'), detail: PageChangedDetailSchema }).strict()])
      .parse(await captureStep(() => chrome.tabs.sendMessage(tabId, { type: 'PREPARE_CAPTURE', observationId, scope }, { frameId: 0 })));
    if ('error' in prepared) throw new PageChangedError(prepared.detail);
    steps.push('PREPARE_CAPTURE');
    current();
    await chrome.debugger.attach(target, '1.3').catch((error: unknown) => {
      lifecycleLog('debugger_attach_failed', { tabId, errorName: error instanceof Error ? error.name : typeof error });
      throw captureError('CAPTURE_DEBUGGER_ATTACH_FAILED', 'The debugger could not attach to this tab.',
        { tabId, errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message.slice(0, 160) : undefined },
        'another debugger client, a restricted page, or a revoked permission');
    });
    attached = true;
    lifecycleLog('debugger_attached', { tabId, observationId: observationId.slice(0, 8) });
    // Allow Chrome's own debugging notice to settle before measuring the page.
    await Promise.race([new Promise(resolve => setTimeout(resolve, 250)), interrupted]);
    await active();
    // Headed browsers have classic scrollbars; Chrome hides them when taking a
    // full-page screenshot. Keep their existing space so centered/responsive
    // content does not move between the DOM snapshot and the image. Overlay
    // scrollbars and sites already reserving a gutter need no intervention.
    const [scrollbar] = await chrome.scripting.executeScript({ target, func: () =>
      innerWidth > document.documentElement.clientWidth && !getComputedStyle(document.documentElement).scrollbarGutter.includes('stable'),
    });
    current();
    if (scrollbar?.result === true) {
      await chrome.scripting.insertCSS({ target, css: captureScrollbarCSS, origin: 'USER' });
      scrollbarReserved = true;
      current();
    }
    // Chrome's screenshot workaround briefly recalculates a 1×1 layout. Hold
    // CSS motion still so responsive transitions cannot animate that temporary
    // layout into the captured image or move controls between capture sections.
    await chrome.scripting.insertCSS({ target, css: captureMotionCSS, origin: 'USER' });
    motionPaused = true;
    current();
    const domStart = performance.now();
    const before = CaptureSnapshotResponseSchema.parse(await captureStep(() => chrome.tabs.sendMessage(tabId, { type: 'COLLECT', observationId, scope }, { frameId: 0 })));
    steps.push('COLLECT');
    // The DOM snapshot exists; the tiles are still being delivered.
    instrument.phase = 'COLLECT';
    const domMs = performance.now() - domStart;
    const layout = LayoutSchema.parse(await command('Page.getLayoutMetrics'));
    const pageSize = { width: Math.ceil(layout.cssContentSize.width), height: Math.ceil(layout.cssContentSize.height) };
    // A viewport capture photographs the screen at the reviewed scroll
    // position: one image instead of a tiled document, so every detector reads
    // a fraction of the pixels. It takes the same native full-surface path as
    // a page tile, clipped at the scroll offset; DOM geometry maps into it
    // through the same captureBounds offset.
    const { scrollY, height: viewportHeight } = before.snapshot.viewport;
    const top = Math.min(Math.max(0, Math.round(scrollY)), pageSize.height - 1);
    const captureBounds = scope === 'page' ? { x: 0, y: 0, ...pageSize }
      : { x: 0, y: top, width: pageSize.width, height: Math.max(1, Math.min(Math.ceil(viewportHeight), pageSize.height - top)) };
    const dpr = before.snapshot.viewport.devicePixelRatio;
    let imageWidth = Math.round(captureBounds.width * dpr);
    const imageHeight = Math.round(captureBounds.height * dpr);
    const tiles = captureTiles(imageWidth, imageHeight, before.snapshot.viewport.height * dpr);
    // Preserve the existing layout dimensions while Chrome expands only the
    // rendering surface. Without this, native full-page capture can reset scroll.
    const zoom = layout.cssVisualViewport?.zoom || 1;
    const metrics = {
      width: Math.round(before.snapshot.viewport.width * zoom), height: Math.round(before.snapshot.viewport.height * zoom),
      deviceScaleFactor: dpr / zoom, mobile: false, dontSetVisibleSize: true,
    };
    await command('Emulation.setDeviceMetricsOverride', metrics);
    let encodedBytes = 0;
    for (const [index, tile] of tiles.entries()) {
      await active();
      const { data } = ScreenshotSchema.parse(await command('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: true,
        // Convert image pixels to CDP's device-independent clip coordinates.
        clip: { x: 0, y: (captureBounds.y + tile.y / dpr) * zoom, width: Math.ceil(captureBounds.width * zoom),
          height: tile.height * zoom / dpr, scale: 1 },
      }));
      const size = pngSize(data);
      if (!size.width || !size.height) {
        throw captureError('CAPTURE_SCREENSHOT_INVALID', 'The screenshot reported no dimensions.',
          { tileIndex: index, width: size.width, height: size.height }, 'zero-sized PNG');
      }
      if (size.width > maxSide || size.height > maxSide) {
        throw captureError('CAPTURE_DIMENSION_LIMIT_EXCEEDED',
          `A screenshot side of ${Math.max(size.width, size.height)} px exceeds the ${maxSide} px maximum.`,
          { tileIndex: index, width: size.width, height: size.height, maximumSide: maxSide }, 'image side over limit');
      }
      if (size.width * size.height > maxPixels) {
        throw captureError('CAPTURE_PIXEL_LIMIT_EXCEEDED',
          `A screenshot of ${size.width * size.height} pixels exceeds the ${maxPixels} pixel maximum.`,
          { tileIndex: index, width: size.width, height: size.height, pixels: size.width * size.height, maximumPixels: maxPixels },
          'image pixel count over limit');
      }
      if (Math.abs(size.width - imageWidth) > (index ? 0 : 2) || Math.abs(size.height - tile.height) > 2 ||
        size.height < tile.end - tile.y) {
        throw captureError('CAPTURE_SCREENSHOT_INVALID', 'The screenshot does not match the tile that was requested.',
          { tileIndex: index, expectedWidth: imageWidth, actualWidth: size.width,
            expectedHeight: tile.height, actualHeight: size.height, requiredHeight: tile.end - tile.y },
          'screenshot dimensions differ from the requested clip');
      }
      imageWidth = size.width;
      // Retained compressed images have a separate budget from decoded tiles.
      // This does not depend on page height, DPR, or a giant bitmap allocation.
      encodedBytes += data.length;
      if (encodedBytes > CAPTURE_LIMITS.maxEncodedBytes) {
        throw captureError('CAPTURE_ENCODED_SIZE_LIMIT_EXCEEDED',
          `The encoded screenshots reached ${encodedBytes} bytes, over the ${CAPTURE_LIMITS.maxEncodedBytes} byte budget.`,
          { tileIndex: index, encodedBytes, maximumEncodedBytes: CAPTURE_LIMITS.maxEncodedBytes, tiles: tiles.length },
          'retained screenshot budget exhausted');
      }
      await Promise.race([onTile({ ...tile, ...size, screenshot: `data:image/png;base64,${data}` }, index, tiles.length), interrupted]);
      current();
    }
    await command('Emulation.clearDeviceMetricsOverride');
    // Every tile was delivered; only the final stability comparison remains.
    instrument.phase = 'CHECK';
    await active();
    const checked = CaptureCheckResponseSchema.parse(await captureStep(() => chrome.tabs.sendMessage(tabId, { type: 'CHECK', observationId, scope }, { frameId: 0 })));
    current();
    if ('error' in checked) throw new PageChangedError(checked.detail);
    steps.push('CHECK');
    instrument.phase = 'NONE';
    // One semantic comparison of the values the screenshots depend on. DOM
    // churn between COLLECT and CHECK is not consulted and is not a failure.
    const decision = compareCaptureStability({ dom: before.snapshot, stability: before.stability },
      { dom: checked.snapshot, stability: checked.stability });
    console.info(`[CAPTURE][${observationId}] page_stable=${decision.stable} ` +
      `document=${checked.stability.documentWidth}x${checked.stability.documentHeight} ` +
      `viewport=${checked.stability.viewportWidth}x${checked.stability.viewportHeight} ` +
      `scroll=${checked.stability.scrollX},${checked.stability.scrollY} controls=${checked.stability.interactiveElementCount}`);
    if (!decision.stable) {
      const detail = pageChangedDetail(decision.reason, checked.mutations,
        { dom: before.snapshot, stability: before.stability }, { dom: checked.snapshot, stability: checked.stability });
      console.warn(`[CAPTURE][${observationId}][PAGE_CHANGED] reason=${decision.reason}`);
      throw new PageChangedError(detail);
    }
    await captureStep(() => chrome.tabs.sendMessage(tabId, { type: 'FINISH_CAPTURE', observationId }, { frameId: 0 }));
    current();
    return { dom: checked.snapshot, captureBounds, pageSize, scope, imageWidth, imageHeight, tileCount: tiles.length, capturedAt,
      captureMs: performance.now() - started, domMs };
  } finally {
    onEnd?.({ phase: instrument.phase, steps: [...steps], signalAborted: signal?.aborted === true });
    clearTimeout(deadline);
    clearTimeout(totalDeadline);
    signal?.removeEventListener('abort', abort);
    chrome.debugger.onDetach.removeListener(detached);
    // Runs on success, Stop, navigation, browser cancellation and errors.
    // Detaching also drops this session's emulation if a command was interrupted.
    lifecycleLog('debugger_detach', { tabId, attached, elapsedMs: Math.round(performance.now() - started) });
    if (attached) await chrome.debugger.detach(target).catch(() => {});
    // Remove only this capture's stylesheet; never edit the site's style
    // attributes or leave a layout override after success, Stop, or failure.
    if (scrollbarReserved) await chrome.scripting.removeCSS({ target, css: captureScrollbarCSS, origin: 'USER' }).catch(() => {});
    if (motionPaused) await chrome.scripting.removeCSS({ target, css: captureMotionCSS, origin: 'USER' }).catch(() => {});
  }
}

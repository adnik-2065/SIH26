import { z } from 'zod';
import { DomSnapshotSchema, type CaptureObservation, type CaptureTile } from '../contracts';
import { captureTiles } from './tiles';

const LayoutSchema = z.object({
  cssContentSize: z.object({ width: z.number().positive().finite(), height: z.number().positive().finite() }),
  cssVisualViewport: z.object({ zoom: z.number().positive().finite().optional() }).optional(),
});
const ScreenshotSchema = z.object({ data: z.string().min(44).max(29_999_978).regex(/^[A-Za-z0-9+/]+={0,2}$/) });
const maxPixels = 32_000_000;
const maxSide = 32_767;
const captureScrollbarCSS = ':root { scrollbar-gutter: stable !important; }';
const captureMotionCSS = '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }';

// Read PNG dimensions without decompressing another full-page bitmap in the
// background worker. Actual image decoding belongs to the panel.
function pngSize(encoded: string) {
  const bytes = Uint8Array.from(atob(encoded.slice(0, 44)), character => character.charCodeAt(0));
  if ([137, 80, 78, 71, 13, 10, 26, 10].some((byte, i) => bytes[i] !== byte) ||
    String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') throw new Error('CAPTURE_FAILED');
  const header = new DataView(bytes.buffer);
  return { width: header.getUint32(16), height: header.getUint32(20) };
}

export async function observeTab(tabId: number, windowId: number, origin: string, observationId: string,
  check: () => void, signal?: AbortSignal,
  onTile: (tile: CaptureTile, index: number, count: number) => Promise<void> = async () => {}): Promise<CaptureObservation> {
  const target = { tabId };
  let attached = false;
  let scrollbarReserved = false;
  let motionPaused = false;
  let failure: Error | undefined;
  let rejectInterrupted!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  // An abort can arrive while attach() is still pending.
  void interrupted.catch(() => {});
  const interrupt = (code: string) => { failure ??= new Error(code); rejectInterrupted(failure); };
  const abort = () => interrupt('STOPPED');
  const detached = (source: chrome.debugger.Debuggee) => {
    if (source.tabId === tabId && attached) { attached = false; interrupt('CAPTURE_FAILED'); }
  };
  const current = () => { if (failure) throw failure; if (signal?.aborted) throw new Error('STOPPED'); check(); };
  const active = async () => {
    current();
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id !== tabId || !tab.url || new URL(tab.url).origin !== origin) throw new Error('PAGE_CHANGED');
    current();
  };
  const command = async (method: string, parameters?: object) => {
    current();
    // A long page can take longer than one screenshot, but a stalled command
    // still times out promptly. Stop also interrupts any command immediately.
    clearTimeout(deadline);
    deadline = setTimeout(() => interrupt('CAPTURE_FAILED'), 15_000);
    const result = await Promise.race([chrome.debugger.sendCommand(target, method, parameters), interrupted]);
    current();
    return result;
  };
  signal?.addEventListener('abort', abort, { once: true });
  let deadline = setTimeout(() => interrupt('CAPTURE_FAILED'), 15_000);
  const totalDeadline = setTimeout(() => interrupt('CAPTURE_FAILED'), 120_000);
  chrome.debugger.onDetach.addListener(detached);
  const started = performance.now();
  const capturedAt = Date.now();
  try {
    await active();
    // Injection first preserves the existing user-granted activeTab boundary.
    await chrome.scripting.executeScript({ target, files: ['content.js'] });
    current();
    // The panel can be clicked while Chrome is still animating it open. Measure
    // the pre-notice viewport only after that animation has settled; otherwise
    // the panel's inset gets mistaken for part of the debugging notice.
    await Promise.race([chrome.scripting.executeScript({ target, func: async function waitForStableViewport() {
      const started = performance.now();
      let last = `${innerWidth}:${innerHeight}:${devicePixelRatio}`, stableSince = started;
      while (performance.now() - stableSince < 150 && performance.now() - started < 1500) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const next = `${innerWidth}:${innerHeight}:${devicePixelRatio}`;
        if (next !== last) { last = next; stableSince = performance.now(); }
      }
    } }), interrupted]);
    current();
    z.object({ ok: z.literal(true) }).parse(await chrome.tabs.sendMessage(tabId, { type: 'PREPARE_CAPTURE', observationId }, { frameId: 0 }));
    current();
    await chrome.debugger.attach(target, '1.3');
    attached = true;
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
    const before = DomSnapshotSchema.parse(await chrome.tabs.sendMessage(tabId, { type: 'COLLECT', observationId }, { frameId: 0 }));
    const domMs = performance.now() - domStart;
    const layout = LayoutSchema.parse(await command('Page.getLayoutMetrics'));
    const captureBounds = { x: 0, y: 0, width: Math.ceil(layout.cssContentSize.width), height: Math.ceil(layout.cssContentSize.height) };
    const dpr = before.viewport.devicePixelRatio;
    let imageWidth = Math.round(captureBounds.width * dpr);
    const imageHeight = Math.round(captureBounds.height * dpr);
    const tiles = captureTiles(imageWidth, imageHeight, before.viewport.height * dpr);
    // Preserve the existing layout dimensions while Chrome expands only the
    // rendering surface. Without this, native full-page capture can reset scroll.
    const zoom = layout.cssVisualViewport?.zoom || 1;
    const metrics = {
      width: Math.round(before.viewport.width * zoom), height: Math.round(before.viewport.height * zoom),
      deviceScaleFactor: dpr / zoom, mobile: false, dontSetVisibleSize: true,
    };
    await command('Emulation.setDeviceMetricsOverride', metrics);
    let encodedBytes = 0;
    for (const [index, tile] of tiles.entries()) {
      await active();
      const { data } = ScreenshotSchema.parse(await command('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: true,
        // Convert image pixels to CDP's device-independent clip coordinates.
        clip: { x: 0, y: tile.y * zoom / dpr, width: Math.ceil(captureBounds.width * zoom),
          height: tile.height * zoom / dpr, scale: 1 },
      }));
      const size = pngSize(data);
      if (!size.width || !size.height || size.width > maxSide || size.height > maxSide || size.width * size.height > maxPixels ||
        Math.abs(size.width - imageWidth) > (index ? 0 : 2) || Math.abs(size.height - tile.height) > 2 ||
        size.height < tile.end - tile.y) throw new Error('CAPTURE_FAILED');
      imageWidth = size.width;
      // Retained compressed images have a separate budget from decoded tiles.
      // This does not depend on page height, DPR, or a giant bitmap allocation.
      encodedBytes += data.length;
      if (encodedBytes > 128_000_000) throw new Error('CAPTURE_TOO_LARGE');
      await Promise.race([onTile({ ...tile, ...size, screenshot: `data:image/png;base64,${data}` }, index, tiles.length), interrupted]);
      current();
    }
    await command('Emulation.clearDeviceMetricsOverride');
    await active();
    const after = DomSnapshotSchema.parse(await chrome.tabs.sendMessage(tabId, { type: 'CHECK', observationId }, { frameId: 0 }));
    current();
    // No scrolling: real interaction/mutation still
    // invalidates a stale screenshot, even while capture is running.
    if (before.origin !== origin || JSON.stringify(before) !== JSON.stringify(after)) throw new Error('PAGE_CHANGED');
    await chrome.tabs.sendMessage(tabId, { type: 'FINISH_CAPTURE', observationId }, { frameId: 0 });
    current();
    return { dom: after, captureBounds, imageWidth, imageHeight, tileCount: tiles.length, capturedAt,
      captureMs: performance.now() - started, domMs };
  } finally {
    clearTimeout(deadline);
    clearTimeout(totalDeadline);
    signal?.removeEventListener('abort', abort);
    chrome.debugger.onDetach.removeListener(detached);
    // Runs on success, Stop, navigation, browser cancellation and errors.
    // Detaching also drops this session's emulation if a command was interrupted.
    if (attached) await chrome.debugger.detach(target).catch(() => {});
    // Remove only this capture's stylesheet; never edit the site's style
    // attributes or leave a layout override after success, Stop, or failure.
    if (scrollbarReserved) await chrome.scripting.removeCSS({ target, css: captureScrollbarCSS, origin: 'USER' }).catch(() => {});
    if (motionPaused) await chrome.scripting.removeCSS({ target, css: captureMotionCSS, origin: 'USER' }).catch(() => {});
  }
}

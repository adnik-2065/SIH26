$ErrorActionPreference = 'Stop'
$spec = @'
import { test, expect, chromium } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// PROBE: mask provenance on the My-Courses-like fixture. No PII exists on this
// page, so every mask in the redacted export is a false positive by definition.
// This spec is NOT part of the regular suite (prefixed probe-); it writes its
// evidence to /tmp for the investigation report.
test('mask provenance on My-Courses fixture', async () => {
  test.setTimeout(240_000);
  const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'sih26-probe-mask-')), {
    channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--enable-unsafe-extension-debugging', '--window-size=1268,1000'],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    // Paint interception lives in the panel: every fillRect on the summary
    // canvas is one painted mask; log bounds as painted.
    await panel.evaluate(() => {
      const events: unknown[] = [];
      (window as unknown as { probeEvents: unknown[] }).probeEvents = events;
      const Native = window.OffscreenCanvas;
      window.OffscreenCanvas = class extends Native {
        constructor(w?: number | Uint8Array, h?: number) { super(w as number, h as number); }
      } as typeof OffscreenCanvas;
      const fill = OffscreenCanvasRenderingContext2D.prototype.fillRect;
      const paint = OffscreenCanvasRenderingContext2D.prototype.fillRect;
      // Track which canvas is the summary (largest) and which are tiles.
      const sizes: Array<{ canvas: unknown; w: number; h: number }> = [];
      window.OffscreenCanvas = class extends Native {
        constructor(w?: number | Uint8Array, h?: number) { super(w as number, h as number); sizes.push({ canvas: this, w: (this as unknown as OffscreenCanvas).width, h: (canvasW => canvasW)( (this as unknown as OffscreenCanvas).width ) }); (this as unknown as { probeSize?: unknown }).probeSize = { w: (this as unknown as OffscreenCanvas).width, h: (this as unknown as OffscreenCanvas).height }; }
      } as typeof OffscreenCanvas;
      OffscreenCanvasRenderingContext2D.prototype.fillRect = function (x: number, y: number, w: number, h: number) {
        fill.call(this, x, y, w, h);
        const canvas = this.canvas as { probeSize?: { w: number; h: number }; width: number; height: number };
        events.push({ type: 'fillRect', x, y, w, h, canvasW: canvas?.width, canvasH: canvas?.height, probeSize: canvas?.probeSize });
      };
      (window as unknown as { probeSizes: unknown[] }).probeSizes = sizes;
    });
    const portal = await context.newPage(); await portal.goto('http://127.0.0.1:4173/my-courses.html');
    await portal.locator('img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
    const browserSession = await context.browser()!.newBrowserCDPSession();
    const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
    await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: targetInfos.find(target => target.url === portal.url())!.targetId });
    // Start a run (payload is auto-prepared and the request is intercepted).
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START', instruction: 'Summarize my courses' }));
    // Wait for the intercepted request OR a hard failure state.
    await expect.poll(async () => {
      const state = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STATUS' }))).state;
      const events = await panel.evaluate(() => (window as unknown as { probeEvents: unknown[] }).probeEvents);
      return { status: state.status, error: state.error ?? null, fills: events.length };
    }, { timeout: 120_000 }).toEqual({ status: 'paused', error: null, fills: expect.any(Number) });
    const evidence = await panel.evaluate(() => ({
      state: (window as unknown as { probeEvents: unknown[] }) ? undefined : undefined,
      events: (window as unknown as { probeEvents: unknown[] }).probeEvents,
    }));
    const events = (await panel.evaluate(() => (window as unknown as { probeEvents: unknown[] }).probeEvents)) as Array<{ type: string; x: number; y: number; w: number; h: number; canvasW: number; canvasH: number }>;
    // Scrape the detection panels for per-source counts.
    const detection = await panel.evaluate(() => ({
      words: [...document.querySelectorAll('.ocr-results li .coordinates')].map(el => el.textContent),
      faces: [...document.querySelectorAll('.face-results li .coordinates')].map(el => el.textContent),
      wordsCount: document.querySelector('#text-tab')?.textContent,
      facesCount: document.querySelector('#faces-tab')?.textContent,
      summaryStats: [...document.querySelectorAll('.summary-stats li')].map(el => el.textContent),
      ocrError: document.querySelector('[role=alert]')?.textContent ?? null,
    });
    require('node:fs').writeFileSync('/tmp/probe-mask-evidence.json', JSON.stringify({ events, detection }, null, 2));
  } finally { await context.close(); }
});
'@
[IO.File]::WriteAllText("$PWD\tests\browser\probe-mask.spec.ts", $spec)
Write-Output 'probe spec written'

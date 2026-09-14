import { test, expect, chromium, type CDPSession } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// The native sidebar is an "other" CDP target, not a normal Playwright page.
// Drive its actual DOM so this exercises a real panel button and message sender.
async function sidebar(browser: CDPSession, targetId: string) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: false });
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  browser.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else if (message.result?.exceptionDetails) request.reject(new Error(JSON.stringify(message.result.exceptionDetails)));
    else request.resolve(message.result?.result?.value);
  });
  return async function evaluate<T>(expression: string): Promise<T> {
    const id = ++nextId;
    const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    await browser.send('Target.sendMessageToTarget', { sessionId,
      message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } }),
    });
    return result as Promise<T>;
  };
}

for (const zoom of [1, 1.25]) test(`scan details through the actual browser side panel at ${zoom * 100}% zoom`, async ({ browserName }, testInfo) => {
  const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'sih26-real-panel-')), {
    executablePath: process.env.SIH26_BROWSER_PATH,
    channel: process.env.SIH26_BROWSER_PATH ? undefined : 'chromium',
    headless: process.env.SIH26_HEADED !== '1', viewport: null,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`,
      '--enable-unsafe-extension-debugging', '--window-size=1920,1080', '--force-device-scale-factor=1'],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(() => {
      const diagnostics: unknown[] = [];
      (globalThis as unknown as { scanDiagnostics: unknown[] }).scanDiagnostics = diagnostics;
      const native = chrome.debugger.sendCommand.bind(chrome.debugger);
      chrome.debugger.sendCommand = (async (target: chrome.debugger.Debuggee, method: string, parameters?: object) => {
        try {
          const result = await native(target, method, parameters);
          const scope = globalThis as unknown as { delayCapture?: boolean; releaseCapture?: () => void };
          if (method === 'Page.captureScreenshot' && scope.delayCapture) {
            await new Promise<void>(resolve => { scope.releaseCapture = resolve; });
          }
          const data = (result as { data?: string })?.data;
          const header = data ? new DataView(Uint8Array.from(atob(data.slice(0, 44)), c => c.charCodeAt(0)).buffer) : undefined;
          diagnostics.push({ method, parameters, result: method === 'Page.getLayoutMetrics' ? result : header ? { width: header.getUint32(16), height: header.getUint32(20) } : undefined });
          return result;
        } catch (error) { diagnostics.push({ method, error: String(error) }); throw error; }
      }) as typeof chrome.debugger.sendCommand;
      const nativeMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (async (tabId: number, message: { type: string }, options?: chrome.tabs.MessageSendOptions) => {
        const result = options ? await nativeMessage(tabId, message, options) : await nativeMessage(tabId, message);
        diagnostics.push({ message: message.type, viewport: result?.viewport, revision: result?.revision, elements: result?.elements, hiddenCount: result?.hiddenCount, error: result?.error });
        return result;
      }) as typeof chrome.tabs.sendMessage;
    });
    const portal = await context.newPage();
    await portal.goto('http://127.0.0.1:4173/');
    await portal.locator('img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
    const browser = await context.browser()!.newBrowserCDPSession();
    const targets = await browser.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
    await browser.send('Extensions.triggerAction', { id: extensionId, targetId: targets.targetInfos.find(item => item.url === portal.url())!.targetId });
    await worker.evaluate(async zoom => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.setZoom(tab.id!, zoom);
    }, zoom);
    let panelId = '';
    await expect.poll(async () => {
      const targets = await browser.send('Target.getTargets');
      panelId = targets.targetInfos.find(item => item.url === `chrome-extension://${extensionId}/panel.html`)?.targetId || '';
      return panelId;
    }).not.toBe('');
    const panel = await sidebar(browser, panelId);
    await expect.poll(() => panel<string>('document.querySelector(".primary")?.textContent')).toContain('Scan current page');
    const originalStyle = await portal.locator('html').getAttribute('style');
    const originalGutter = await portal.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter);
    const results: Array<{ scenario: string; metrics: string }> = [];
    const scan = async (scenario: string, faceCount: number) => {
      const before = await worker.evaluate(async () => (await chrome.storage.session.get('task')).task.generation);
      await expect.poll(() => panel<boolean>('document.querySelector(".primary")?.disabled')).toBe(false);
      await panel('document.querySelector(".primary").click()');
      await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.session.get('task')).task.generation)).toBeGreaterThan(before);
      await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.session.get('task')).task.status)).not.toBe('observing');
      const state = await worker.evaluate(async () => (await chrome.storage.session.get('task')).task);
      const diagnostics = await worker.evaluate(() => (globalThis as unknown as { scanDiagnostics: unknown[] }).scanDiagnostics);
      expect(state.error, JSON.stringify({ scenario, state, diagnostics })).toBeUndefined();
      await expect.poll(() => panel<string>('document.querySelector(".status")?.textContent'), { timeout: 90_000 }).toContain('Scan ready to review');
      // OCR may split an email into neighboring words at different zoom levels.
      expect((await panel<string>('Array.from(document.querySelectorAll(".ocr-results strong"), word => word.textContent).join("")')).replace(/\s+/g, '')).toContain('student@example.test');
      expect(await panel<number>('document.querySelectorAll(".face-results li").length')).toBe(faceCount);
      expect(await portal.locator('html').getAttribute('style')).toBe(originalStyle);
      expect(await portal.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter)).toBe(originalGutter);
      expect(await worker.evaluate(async tabId => chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics').then(() => true, () => false), state.tabId)).toBe(false);
      results.push({ scenario, metrics: await panel<string>('document.querySelector(".metrics")?.innerText') });
    };
    await test.step('read the unchanged synthetic details', () => scan('initial', 1));
    await test.step('rescan from the real panel', () => scan('repeat', 1));
    await test.step('read a deferred portrait and text below the fold without scrolling', async () => {
      await portal.evaluate(() => {
        const section = document.createElement('section');
        section.style.cssText = 'padding-top:2500px;background:white;color:black';
        section.innerHTML = '<p style="font:32px Arial">EndOfFacultyList</p><img loading="lazy" src="/assets/synthetic-face.png" width="220" height="220">';
        document.body.append(section);
        document.querySelector<HTMLInputElement>('#name')!.focus({ preventScroll: true });
        window.scrollTo(0, 250);
      });
      await expect.poll(async () => portal.evaluate(() => Math.abs(scrollY - 250))).toBeLessThan(1);
      const position = await portal.evaluate(() => ({ x: scrollX, y: scrollY, focus: document.activeElement?.id }));
      await scan('below-fold', 2);
      expect(await panel<string>('document.querySelector(".ocr-results")?.textContent')).toContain('EndOfFacultyList');
      expect(await portal.evaluate(() => ({ x: scrollX, y: scrollY, focus: document.activeElement?.id }))).toEqual(position);
      await expect(portal.locator('img[loading]')).toHaveAttribute('loading', 'lazy');
    });
    await test.step('Stop cancels a pending capture and removes the temporary stylesheet', async () => {
      await worker.evaluate(() => { (globalThis as unknown as { delayCapture: boolean }).delayCapture = true; });
      await panel('document.querySelector(".primary").click()');
      await expect.poll(() => worker.evaluate(() => !!(globalThis as unknown as { releaseCapture?: () => void }).releaseCapture), { intervals: [50] }).toBe(true);
      await panel('document.querySelector(".stop").click()');
      await expect.poll(() => worker.evaluate(async () => (await chrome.storage.session.get('task')).task.status)).toBe('stopped');
      await expect.poll(() => portal.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter)).toBe(originalGutter);
      expect(await panel<number>('document.querySelectorAll("canvas").length')).toBe(0);
      await worker.evaluate(() => {
        const scope = globalThis as unknown as { delayCapture: boolean; releaseCapture?: () => void };
        scope.delayCapture = false; scope.releaseCapture?.(); delete scope.releaseCapture;
      });
      await scan('after-stop', 2);
    });
    await testInfo.attach('real-panel-results', { body: JSON.stringify({ browserName, browser: context.browser()!.version(), zoom, results }, null, 2), contentType: 'application/json' });
    console.log('Real side panel results:', results);
  } finally { await context.close(); }
});
